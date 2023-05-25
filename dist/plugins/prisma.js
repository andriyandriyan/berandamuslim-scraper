"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const fastify_plugin_1 = __importDefault(require("fastify-plugin"));
const prismaPlugin = (0, fastify_plugin_1.default)(async (server, options) => {
    const prisma = new client_1.PrismaClient({
        log: process.env.NODE_ENV === 'development' ? ['query'] : undefined,
    });
    await prisma.$connect();
    server.decorate('prisma', prisma);
    server.addHook('onClose', async (server) => {
        await server.prisma.$disconnect();
    });
});
exports.default = prismaPlugin;
