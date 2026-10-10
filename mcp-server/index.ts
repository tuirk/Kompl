import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './src/server.js';

// Entry point that MCP clients launch (`node mcp-server/dist/index.js`).
// stdout carries the protocol, so nothing else may write to it; log to stderr.
const server = createServer({ baseUrl: process.env.KOMPL_URL ?? 'http://localhost:3000' });
await server.connect(new StdioServerTransport());
