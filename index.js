/*jslint node: true */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('util');
const jsonschema = require('jsonschema');
const debug = require('./lib/debug')('jubatus-node-client');
const rpc = require('msgpack-rpc-lite');

const isProduct = process.env.NODE_ENV && (/production/).test(process.env.NODE_ENV);

function toCamelCase(value) {
    return value.replace(/_([a-z])/g, (match, group1) => group1.toUpperCase());
}

function toOptions(args) {
    const first = args.shift() || {};
    const rpcClient = first instanceof rpc.Client ? first : first.rpcClient;
    const port = typeof first === 'number' ? first : first.port;
    const host = first.host || args[0];
    const name = first.name || args[1];
    const timeoutSeconds = first.timeoutSeconds || args[2];
    return { rpcClient, port, host, name, timeoutSeconds };
}

function createSuperConstructor() {
    const constructor = function constructor(...args) {
        const options = toOptions(args);
        const { port = 9199, host = 'localhost', timeoutSeconds = 0, rpcClient } = options;
        let { name = '' } = options ;
        const codecOptions = { encode: { useraw: true } };
        const client = rpcClient || rpc.createClient(port, host, timeoutSeconds * 1000, codecOptions);

        Object.defineProperty(this, 'client', {
            get() { return client; }
        });

        Object.defineProperty(this, 'name', {
            get() { return name; },
            set(value) { name = value; }
        });

        return this;
    };

    // This is not an RPC method.
    constructor.prototype.getClient = function () {
        return this.client;
    };

    // This is not an RPC method.
    constructor.prototype.getName = function () {
        return this.name;
    };

    // This is not an RPC method.
    constructor.prototype.setName = function (value) {
        this.name = value;
    };

    return constructor;
}

function buildMethods(schema, constructor) {
    return Object.keys(schema.properties)
        .map(method => schema.properties[method])
        .map(({ id: rpcName, properties: { 'arguments': argumentsSchema, 'return': returnSchema } }) => {
            argumentsSchema.definitions = returnSchema.definitions = schema.definitions;
            const validator = new jsonschema.Validator();
            const methodName = toCamelCase(rpcName),
                assertParams = isProduct ? () => {} : params => {
                    const result = validator.validate(params, argumentsSchema);
                    assert.ok(result.valid, util.format('%j', result.errors));
                },
                assertReturn = isProduct ? () => {} : returnValue => {
                    const result = validator.validate(returnValue, returnSchema);
                    assert.ok(result.valid, util.format('%j', result.errors));
                };
            return [ rpcName, methodName, assertParams, assertReturn ];
        })
        .reduce((constructor, [ rpcName, methodName, assertParams, assertReturn ]) => {
            constructor.prototype[methodName] = function (...params) {
                const self = this,
                    client = self.getClient(),
                    callback = (typeof params[params.length - 1] === 'function') && params.pop();
                assertParams(params);
                params.unshift(self.getName());
                if (callback) {
                    client.request.apply(client, [ rpcName ].concat(params, (error, result, msgid) => {
                        if (!error) { assertReturn(result); }
                        callback.call(self, error, result, msgid);
                    }));
                } else {
                    return client.request.apply(client, [ rpcName ].concat(params));
                }
            };
            return constructor;
        }, constructor);
}

function createConstructor(className, schema, superConstructor) {
    const constructor = function constructor(...args) {
        assert(this instanceof constructor, `${className} is constructor.`);

        superConstructor.apply(this, args);
        return this;
    };
    util.inherits(constructor, superConstructor);
    return buildMethods(schema, constructor);
}

const dirname = path.resolve(__dirname, './api/');
const services = fs.readdirSync(dirname)
    .map(file => path.resolve(dirname, file))
    .filter(file => path.extname(file) === '.json')
    .filter(file => fs.statSync(file).isFile())
    .map(file => {
        const service = toCamelCase('_' + path.basename(file, '.json'));
        const schema = JSON.parse(fs.readFileSync(file));
        return ({ [service]: schema });
    })
    .reduce((accumulator, current) => Object.assign(accumulator, current));
const { Common: common } = services;
const schemas = Object.keys(services)
    .filter(serviceName => serviceName !== 'Common')
    .map(serviceName =>{
        const service = services[serviceName];
        service.definitions = Object.assign(service.definitions, common.definitions);
        service.properties = Object.assign(service.properties, common.properties);
        return { [serviceName]: service };
    })
    .reduce((accumulator, current) => Object.assign(accumulator, current));
const superConstructor = createSuperConstructor();
Object.keys(schemas).forEach(function (className) {
    const schema = schemas[className];
    debug(className, schema);
    const constructor = createConstructor(className, schema, superConstructor);
    module.exports[className.toLowerCase()] = { client: { [className]: constructor } };
});