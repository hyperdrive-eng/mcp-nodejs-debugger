#!/usr/bin/env node

// This file serves as the entry point for the MCP debugger
// When installed globally or run with npx, this file will be executed

// Import and run the MCP server
import './src/mcp-server.js';

// The server is started in the imported file
console.log('MCP Debugger started. Connected to Node.js Inspector protocol.');