import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from 'ws';
import fetch from 'node-fetch';

// Create an MCP server
const server = new McpServer({
  name: "Inspector",
  version: "1.0.0",
  description: `Node.js debugger that allows setting breakpoints and inspecting variables.
  	When using debugging capabilities, always instruct the user to navigate to their 
	website after setting breakpoints. Breakpoints will only be triggered when the user 
	interacts with their website in a way that causes the code at the breakpoint location to execute.
	When user requests debugging, always use the following format:
	1. Set breakpoint
	2. Wait for user to navigate to their website and trigger breakpoint
	3. Inspect variables
	4. Execute code
	5. Step over
	6. Step into
	7. Step out
	8. Continue execution
	9. Delete breakpoint
	10. List breakpoints
	11. Get current location
	12. Evaluate expression
	13. Get script source
	14. Get properties`
});

class Inspector {
	constructor(port = 9229, retryOptions = { maxRetries: 5, retryInterval: 1000 }) {
		this.port = port;
		this.connected = false;
		this.pendingRequests = new Map();
		this.debuggerEnabled = false;
		this.breakpoints = new Map();
		this.paused = false;
		this.currentCallFrames = [];
		this.retryOptions = retryOptions;
		this.retryCount = 0;
		this.callbackHandlers = new Map();
		this.initialize();
	}

	async initialize() {
		try {
			// First, get the WebSocket URL from the inspector JSON API
			// Use 127.0.0.1 instead of localhost to avoid IPv6 issues
			const response = await fetch(`http://127.0.0.1:${this.port}/json`);
			const data = await response.json();
			const debuggerUrl = data[0]?.webSocketDebuggerUrl;
			
			if (!debuggerUrl) {
				console.error('No WebSocket debugger URL found');
				this.scheduleRetry();
				return;
			}
			
			console.log(`Connecting to debugger at: ${debuggerUrl}`);
			this.ws = new WebSocket(debuggerUrl);
			
			this.ws.on('open', () => {
				console.log('WebSocket connection established');
				this.connected = true;
				this.retryCount = 0;
				this.enableDebugger();
			});
			
			this.ws.on('error', (error) => {
				console.error('WebSocket error:', error.message);
				this.scheduleRetry();
			});
			
			this.ws.on('close', () => {
				console.log('WebSocket connection closed');
				this.connected = false;
				this.scheduleRetry();
			});
			
			this.ws.on('message', (data) => {
				const response = JSON.parse(data.toString());
				
				// Handle events
				if (response.method) {
					this.handleEvent(response);
					return;
				}
				
				// Handle response for pending request
				if (response.id && this.pendingRequests.has(response.id)) {
					const { resolve, reject } = this.pendingRequests.get(response.id);
					this.pendingRequests.delete(response.id);
					
					if (response.error) {
						reject(response.error);
					} else {
						resolve(response.result);
					}
				}
			});
		} catch (error) {
			console.error('Error initializing inspector:', error.message);
			this.scheduleRetry();
		}
	}
	
	scheduleRetry() {
		if (this.retryCount < this.retryOptions.maxRetries) {
			this.retryCount++;
			console.log(`Retrying connection (${this.retryCount}/${this.retryOptions.maxRetries})...`);
			setTimeout(() => this.initialize(), this.retryOptions.retryInterval);
		} else {
			console.error(`Failed to connect after ${this.retryOptions.maxRetries} attempts`);
		}
	}
	
	async enableDebugger() {
		if (!this.debuggerEnabled && this.connected) {
			try {
				await this.send('Debugger.enable', {});
				console.log('Debugger enabled');
				this.debuggerEnabled = true;
				
				// Setup event listeners
				await this.send('Runtime.enable', {});
				
				// Also activate possible domains we'll need
				await this.send('Runtime.runIfWaitingForDebugger', {});
			} catch (err) {
				console.error('Failed to enable debugger:', err);
			}
		}
	}
	
	handleEvent(event) {
		// console.log('Event received:', event.method, event.params);
		
		switch (event.method) {
			case 'Debugger.paused':
				this.paused = true;
				this.currentCallFrames = event.params.callFrames;
				console.log('Execution paused at breakpoint');
				
				// Notify any registered callbacks for pause events
				if (this.callbackHandlers.has('paused')) {
					this.callbackHandlers.get('paused').forEach(callback => 
						callback(event.params));
				}
				break;
				
			case 'Debugger.resumed':
				this.paused = false;
				this.currentCallFrames = [];
				console.log('Execution resumed');
				
				// Notify any registered callbacks for resume events
				if (this.callbackHandlers.has('resumed')) {
					this.callbackHandlers.get('resumed').forEach(callback => 
						callback());
				}
				break;
				
			case 'Debugger.scriptParsed':
				// Script parsing might be useful for source maps
				break;
				
			case 'Runtime.exceptionThrown':
				console.log('Exception thrown:', 
					event.params.exceptionDetails.text,
					event.params.exceptionDetails.exception?.description || '');
				break;
				
			case 'Runtime.consoleAPICalled':
				// Handle console logs from the debugged program
				const args = event.params.args.map(arg => {
					if (arg.type === 'string') return arg.value;
					if (arg.type === 'number') return arg.value;
					if (arg.type === 'boolean') return arg.value;
					if (arg.type === 'object') {
						if (arg.value) {
							return JSON.stringify(arg.value, null, 2);
						} else if (arg.objectId) {
							// We'll try to get properties later as we can't do async here
							return arg.description || `[${arg.subtype || arg.type}]`;
						} else {
							return arg.description || `[${arg.subtype || arg.type}]`;
						}
					}
					return JSON.stringify(arg);
				}).join(' ');
				
				// Store console logs to make them available to the MCP tools
				if (!this.consoleOutput) {
					this.consoleOutput = [];
				}
				this.consoleOutput.push({
					type: event.params.type,
					message: args,
					timestamp: Date.now(),
					raw: event.params.args
				});
				
				// Keep only the last 100 console messages to avoid memory issues
				if (this.consoleOutput.length > 100) {
					this.consoleOutput.shift();
				}
				
				console.log(`[Console.${event.params.type}]`, args);
				break;
		}
	}
	
	registerCallback(event, callback) {
		if (!this.callbackHandlers.has(event)) {
			this.callbackHandlers.set(event, []);
		}
		this.callbackHandlers.get(event).push(callback);
	}
	
	unregisterCallback(event, callback) {
		if (this.callbackHandlers.has(event)) {
			const callbacks = this.callbackHandlers.get(event);
			const index = callbacks.indexOf(callback);
			if (index !== -1) {
				callbacks.splice(index, 1);
			}
		}
	}

	async send(method, params) {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(`Request timed out: ${method}`));
				this.pendingRequests.delete(id);
			}, 5000);
			
			const checkConnection = () => {
				if (this.connected) {
					try {
						const id = Math.floor(Math.random() * 1000000);
						this.pendingRequests.set(id, { 
							resolve: (result) => {
								clearTimeout(timeout);
								resolve(result);
							}, 
							reject: (err) => {
								clearTimeout(timeout);
								reject(err);
							} 
						});
						
						this.ws.send(JSON.stringify({
							id,
							method,
							params
						}));
					} catch (err) {
						clearTimeout(timeout);
						reject(err);
					}
				} else {
					const connectionCheckTimer = setTimeout(checkConnection, 100);
					// If still not connected after 3 seconds, reject the promise
					setTimeout(() => {
						clearTimeout(connectionCheckTimer);
						clearTimeout(timeout);
						reject(new Error('Not connected to debugger'));
					}, 3000);
				}
			};
			
			checkConnection();
		});
	}
	
	async getScriptSource(scriptId) {
		try {
			const response = await this.send('Debugger.getScriptSource', {
				scriptId
			});
			return response.scriptSource;
		} catch (err) {
			console.error('Error getting script source:', err);
			return null;
		}
	}
	
	async evaluateOnCallFrame(callFrameId, expression) {
		if (!this.paused) {
			throw new Error('Debugger is not paused');
		}
		
		try {
			return await this.send('Debugger.evaluateOnCallFrame', {
				callFrameId,
				expression,
				objectGroup: 'console',
				includeCommandLineAPI: true,
				silent: false,
				returnByValue: true,
				generatePreview: true
			});
		} catch (err) {
			console.error('Error evaluating expression:', err);
			throw err;
		}
	}
	
	async getProperties(objectId, ownProperties = true) {
		try {
			return await this.send('Runtime.getProperties', {
				objectId,
				ownProperties,
				accessorPropertiesOnly: false,
				generatePreview: true
			});
		} catch (err) {
			console.error('Error getting properties:', err);
			throw err;
		}
	}
}

// Create the inspector instance
const inspector = new Inspector(9229);

// Initialize console output storage
inspector.consoleOutput = [];

// Execute JavaScript code
server.tool(
  "nodejs_inspect",
  "Executes JavaScript code in the debugged process",
  {
    js_code: z.string().describe("JavaScript code to execute")
  },
  async ({ js_code }) => {
    try {
      // Ensure debugger is enabled
      if (!inspector.debuggerEnabled) {
        await inspector.enableDebugger();
      }
      
      // Capture the current console output length to know where to start capturing new output
      const consoleStartIndex = inspector.consoleOutput.length;
      
      // Wrap the code in a try-catch with explicit console logging for errors
      let codeToExecute = `
        try {
          ${js_code}
        } catch (e) {
          console.error('Execution error:', e);
          e;  // Return the error
        }
      `;
      
      const response = await inspector.send('Runtime.evaluate', {
        expression: codeToExecute,
        contextId: 1,
        objectGroup: 'console',
        includeCommandLineAPI: true,
        silent: false,
        returnByValue: true,
        generatePreview: true,
        awaitPromise: true  // This will wait for promises to resolve
      });
      
      // Give some time for console logs to be processed
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Get any console output that was generated during execution
      const consoleOutputs = inspector.consoleOutput.slice(consoleStartIndex);
      const consoleText = consoleOutputs.map(output => 
        `[${output.type}] ${output.message}`
      ).join('\n');
      
      // Process the return value
      let result;
      if (response.result) {
        if (response.result.type === 'object') {
          if (response.result.value) {
            // If we have a value, use it
            result = response.result.value;
          } else if (response.result.objectId) {
            // If we have an objectId but no value, the object was too complex to serialize directly
            // Get more details about the object
            try {
              const objectProps = await inspector.getProperties(response.result.objectId);
              const formattedObject = {};
              
              for (const prop of objectProps.result) {
                if (prop.value) {
                  if (prop.value.type === 'object' && prop.value.subtype !== 'null') {
                    // For nested objects, try to get their details too
                    if (prop.value.objectId) {
                      try {
                        const nestedProps = await inspector.getProperties(prop.value.objectId);
                        const nestedObj = {};
                        for (const nestedProp of nestedProps.result) {
                          if (nestedProp.value) {
                            if (nestedProp.value.value !== undefined) {
                              nestedObj[nestedProp.name] = nestedProp.value.value;
                            } else {
                              nestedObj[nestedProp.name] = nestedProp.value.description || 
                                `[${nestedProp.value.subtype || nestedProp.value.type}]`;
                            }
                          }
                        }
                        formattedObject[prop.name] = nestedObj;
                      } catch (nestedErr) {
                        formattedObject[prop.name] = prop.value.description || 
                          `[${prop.value.subtype || prop.value.type}]`;
                      }
                    } else {
                      formattedObject[prop.name] = prop.value.description || 
                        `[${prop.value.subtype || prop.value.type}]`;
                    }
                  } else if (prop.value.type === 'function') {
                    formattedObject[prop.name] = '[function]';
                  } else if (prop.value.value !== undefined) {
                    formattedObject[prop.name] = prop.value.value;
                  } else {
                    formattedObject[prop.name] = `[${prop.value.type}]`;
                  }
                }
              }
              
              result = formattedObject;
            } catch (propErr) {
              // If we can't get properties, at least show the object description
              result = response.result.description || `[${response.result.subtype || response.result.type}]`;
            }
          } else {
            // Fallback for objects without value or objectId
            result = response.result.description || `[${response.result.subtype || response.result.type}]`;
          }
        } else if (response.result.type === 'undefined') {
          result = undefined;
        } else if (response.result.value !== undefined) {
          result = response.result.value;
        } else {
          result = `[${response.result.type}]`;
        }
      }
      
      let responseContent = [];
      
      // Add console output if there was any
      if (consoleText.length > 0) {
        responseContent.push({
          type: "text", 
          text: `Console output:\n${consoleText}`
        });
      }
      
      // Add the result
      responseContent.push({
        type: "text",
        text: `Code executed successfully. Result: ${JSON.stringify(result, null, 2)}`
      });
      
      return { content: responseContent };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Error executing code: ${err.message}`
        }]
      };
    }
  }
);

// Set breakpoint tool
server.tool(
  "set_breakpoint",
  "Sets a breakpoint at specified line and file",
  {
    file: z.string().describe("File path where to set breakpoint"),
    line: z.number().describe("Line number for breakpoint")
  },
  async ({ file, line }) => {
    try {
      // Ensure debugger is enabled
      if (!inspector.debuggerEnabled) {
        await inspector.enableDebugger();
      }
      
      // Convert file path to a URL-like format that the debugger can understand
      // For local files, typically file:///path/to/file.js
      let fileUrl = file;
      if (!file.startsWith('file://') && !file.startsWith('http://') && !file.startsWith('https://')) {
        fileUrl = `file://${file.startsWith('/') ? '' : '/'}${file}`;
      }
      
      const response = await inspector.send('Debugger.setBreakpointByUrl', {
        lineNumber: line - 1, // Chrome DevTools Protocol uses 0-based line numbers
        urlRegex: fileUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), // Escape special regex characters
        columnNumber: 0
      });
      
      // Store the breakpoint for future reference
      inspector.breakpoints.set(response.breakpointId, { file, line, id: response.breakpointId });
      
      return {
        content: [{
          type: "text",
          text: `Breakpoint set successfully. ID: ${response.breakpointId}`
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Error setting breakpoint: ${err.message}`
        }]
      };
    }
  }
);

// Inspect variables tool
server.tool(
  "inspect_variables",
  "Inspects variables in current scope",
  {
    scope: z.string().optional().describe("Scope to inspect (local/global)")
  },
  async ({ scope = 'local' }) => {
    try {
      // Ensure debugger is enabled
      if (!inspector.debuggerEnabled) {
        await inspector.enableDebugger();
      }
      
      if (scope === 'global' || !inspector.paused) {
        // For global scope or when not paused, use Runtime.globalProperties
        const response = await inspector.send('Runtime.globalLexicalScopeNames', {});
        
        // Get global object properties for a more complete picture
        const globalObjResponse = await inspector.send('Runtime.evaluate', {
          expression: 'this',
          contextId: 1,
          returnByValue: true
        });
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              lexicalNames: response.names,
              globalThis: globalObjResponse.result.value
            }, null, 2)
          }]
        };
      } else {
        // For local scope when paused, get variables from the current call frame
        if (inspector.currentCallFrames.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No active call frames. Debugger is not paused at a breakpoint."
            }]
          };
        }
        
        const frame = inspector.currentCallFrames[0]; // Get top frame
        const scopeChain = frame.scopeChain;
        
        // Create a formatted output of variables in scope
        const result = {};
        
        for (const scopeObj of scopeChain) {
          const { scope, type, name } = scopeObj;
          
          if (type === 'global') continue; // Skip global scope for local inspection
          
          const objProperties = await inspector.getProperties(scope.object.objectId);
          const variables = {};
          
          for (const prop of objProperties.result) {
            if (prop.value && prop.configurable) {
              if (prop.value.type === 'object' && prop.value.subtype !== 'null') {
                variables[prop.name] = `[${prop.value.subtype || prop.value.type}]`;
              } else if (prop.value.type === 'function') {
                variables[prop.name] = '[function]';
              } else if (prop.value.value !== undefined) {
                variables[prop.name] = prop.value.value;
              } else {
                variables[prop.name] = `[${prop.value.type}]`;
              }
            }
          }
          
          result[type] = variables;
        }
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      }
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Error inspecting variables: ${err.message}`
        }]
      };
    }
  }
);

// Step over tool
server.tool(
  "step_over",
  "Steps over to the next line of code",
  {},
  async () => {
    try {
      // Ensure debugger is enabled
      if (!inspector.debuggerEnabled) {
        await inspector.enableDebugger();
      }
      
      if (!inspector.paused) {
        return {
          content: [{
            type: "text",
            text: "Debugger is not paused at a breakpoint"
          }]
        };
      }
      
      await inspector.send('Debugger.stepOver', {});
      
      return {
        content: [{
          type: "text",
          text: "Stepped over to next line"
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Error stepping over: ${err.message}`
        }]
      };
    }
  }
);

// Step into tool
server.tool(
  "step_into",
  "Steps into function calls",
  {},
  async () => {
    try {
      // Ensure debugger is enabled
      if (!inspector.debuggerEnabled) {
        await inspector.enableDebugger();
      }
      
      if (!inspector.paused) {
        return {
          content: [{
            type: "text",
            text: "Debugger is not paused at a breakpoint"
          }]
        };
      }
      
      await inspector.send('Debugger.stepInto', {});
      
      return {
        content: [{
          type: "text",
          text: "Stepped into function call"
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Error stepping into: ${err.message}`
        }]
      };
    }
  }
);

// Step out tool
server.tool(
  "step_out",
  "Steps out of current function",
  {},
  async () => {
    try {
      // Ensure debugger is enabled
      if (!inspector.debuggerEnabled) {
        await inspector.enableDebugger();
      }
      
      if (!inspector.paused) {
        return {
          content: [{
            type: "text",
            text: "Debugger is not paused at a breakpoint"
          }]
        };
      }
      
      await inspector.send('Debugger.stepOut', {});
      
      return {
        content: [{
          type: "text",
          text: "Stepped out of current function"
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Error stepping out: ${err.message}`
        }]
      };
    }
  }
);

// Continue execution tool
server.tool(
  "continue",
  "Continues code execution",
  {},
  async () => {
    try {
      // Ensure debugger is enabled
      if (!inspector.debuggerEnabled) {
        await inspector.enableDebugger();
      }
      
      if (!inspector.paused) {
        return {
          content: [{
            type: "text",
            text: "Debugger is not paused at a breakpoint"
          }]
        };
      }
      
      await inspector.send('Debugger.resume', {});
      
      return {
        content: [{
          type: "text",
          text: "Execution resumed"
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Error continuing execution: ${err.message}`
        }]
      };
    }
  }
);

// Delete breakpoint tool
server.tool(
  "delete_breakpoint",
  "Deletes a specified breakpoint",
  {
    breakpointId: z.string().describe("ID of the breakpoint to remove")
  },
  async ({ breakpointId }) => {
    try {
      // Ensure debugger is enabled
      if (!inspector.debuggerEnabled) {
        await inspector.enableDebugger();
      }
      
      await inspector.send('Debugger.removeBreakpoint', {
        breakpointId: breakpointId
      });
      
      // Remove from our local tracking
      inspector.breakpoints.delete(breakpointId);
      
      return {
        content: [{
          type: "text",
          text: `Breakpoint ${breakpointId} removed`
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Error removing breakpoint: ${err.message}`
        }]
      };
    }
  }
);

// List all breakpoints tool
server.tool(
  "list_breakpoints",
  "Lists all active breakpoints",
  {},
  async () => {
    try {
      // Ensure debugger is enabled
      if (!inspector.debuggerEnabled) {
        await inspector.enableDebugger();
      }
      
      if (inspector.breakpoints.size === 0) {
        return {
          content: [{
            type: "text",
            text: "No active breakpoints"
          }]
        };
      }
      
      const breakpointsList = Array.from(inspector.breakpoints.values());
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(breakpointsList, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Error listing breakpoints: ${err.message}`
        }]
      };
    }
  }
);

// Evaluate expression tool
server.tool(
  "evaluate",
  "Evaluates a JavaScript expression in the current context",
  {
    expression: z.string().describe("JavaScript expression to evaluate")
  },
  async ({ expression }) => {
    try {
      // Ensure debugger is enabled
      if (!inspector.debuggerEnabled) {
        await inspector.enableDebugger();
      }
      
      // Capture the current console output length to know where to start capturing new output
      const consoleStartIndex = inspector.consoleOutput.length;
      
      // Wrap the expression in a try-catch to better handle errors
      const wrappedExpression = `
        try {
          ${expression}
        } catch (e) {
          console.error('Evaluation error:', e);
          e;  // Return the error
        }
      `;
      
      let result;
      
      if (inspector.paused && inspector.currentCallFrames.length > 0) {
        // When paused at a breakpoint, evaluate in the context of the call frame
        const frame = inspector.currentCallFrames[0];
        result = await inspector.evaluateOnCallFrame(frame.callFrameId, wrappedExpression);
      } else {
        // Otherwise, evaluate in the global context
        result = await inspector.send('Runtime.evaluate', {
          expression: wrappedExpression,
          contextId: 1,
          objectGroup: 'console',
          includeCommandLineAPI: true,
          silent: false,
          returnByValue: true,
          generatePreview: true,
          awaitPromise: true  // This will wait for promises to resolve
        });
      }
      
      // Give some time for console logs to be processed
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Get any console output that was generated during execution
      const consoleOutputs = inspector.consoleOutput.slice(consoleStartIndex);
      const consoleText = consoleOutputs.map(output => 
        `[${output.type}] ${output.message}`
      ).join('\n');
      
      let valueRepresentation;
      
      if (result.result) {
        if (result.result.type === 'object') {
          if (result.result.value) {
            // If we have a value, use it
            valueRepresentation = JSON.stringify(result.result.value, null, 2);
          } else if (result.result.objectId) {
            // If we have an objectId but no value, the object was too complex to serialize directly
            // Get more details about the object
            try {
              const objectProps = await inspector.getProperties(result.result.objectId);
              const formattedObject = {};
              
              for (const prop of objectProps.result) {
                if (prop.value) {
                  if (prop.value.type === 'object' && prop.value.subtype !== 'null') {
                    // For nested objects, try to get their details too
                    if (prop.value.objectId) {
                      try {
                        const nestedProps = await inspector.getProperties(prop.value.objectId);
                        const nestedObj = {};
                        for (const nestedProp of nestedProps.result) {
                          if (nestedProp.value) {
                            if (nestedProp.value.value !== undefined) {
                              nestedObj[nestedProp.name] = nestedProp.value.value;
                            } else {
                              nestedObj[nestedProp.name] = nestedProp.value.description || 
                                `[${nestedProp.value.subtype || nestedProp.value.type}]`;
                            }
                          }
                        }
                        formattedObject[prop.name] = nestedObj;
                      } catch (nestedErr) {
                        formattedObject[prop.name] = prop.value.description || 
                          `[${prop.value.subtype || prop.value.type}]`;
                      }
                    } else {
                      formattedObject[prop.name] = prop.value.description || 
                        `[${prop.value.subtype || prop.value.type}]`;
                    }
                  } else if (prop.value.type === 'function') {
                    formattedObject[prop.name] = '[function]';
                  } else if (prop.value.value !== undefined) {
                    formattedObject[prop.name] = prop.value.value;
                  } else {
                    formattedObject[prop.name] = `[${prop.value.type}]`;
                  }
                }
              }
              
              valueRepresentation = JSON.stringify(formattedObject, null, 2);
            } catch (propErr) {
              // If we can't get properties, at least show the object description
              valueRepresentation = result.result.description || `[${result.result.subtype || result.result.type}]`;
            }
          } else {
            // Fallback for objects without value or objectId
            valueRepresentation = result.result.description || `[${result.result.subtype || result.result.type}]`;
          }
        } else if (result.result.type === 'undefined') {
          valueRepresentation = 'undefined';
        } else if (result.result.value !== undefined) {
          valueRepresentation = result.result.value.toString();
        } else {
          valueRepresentation = `[${result.result.type}]`;
        }
      } else {
        valueRepresentation = 'No result';
      }
      
      // Prepare the response content
      let responseContent = [];
      
      // Add console output if there was any
      if (consoleText.length > 0) {
        responseContent.push({
          type: "text", 
          text: `Console output:\n${consoleText}`
        });
      }
      
      // Add the evaluation result
      responseContent.push({
        type: "text",
        text: `Evaluation result: ${valueRepresentation}`
      });
      
      return { content: responseContent };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Error evaluating expression: ${err.message}`
        }]
      };
    }
  }
);

// Get current location tool
server.tool(
  "get_location",
  "Gets the current execution location when paused",
  {},
  async () => {
    try {
      // Ensure debugger is enabled
      if (!inspector.debuggerEnabled) {
        await inspector.enableDebugger();
      }
      
      if (!inspector.paused || inspector.currentCallFrames.length === 0) {
        return {
          content: [{
            type: "text",
            text: "Debugger is not paused at a breakpoint"
          }]
        };
      }
      
      const frame = inspector.currentCallFrames[0];
      const { url, lineNumber, columnNumber } = frame.location;
      
      // Get call stack
      const callstack = inspector.currentCallFrames.map(frame => {
        return {
          functionName: frame.functionName || '(anonymous)',
          url: frame.url,
          lineNumber: frame.location.lineNumber + 1,
          columnNumber: frame.location.columnNumber
        };
      });
      
      // Get source code for context
      let sourceContext = '';
      try {
        const scriptSource = await inspector.getScriptSource(frame.location.scriptId);
        if (scriptSource) {
          const lines = scriptSource.split('\n');
          const startLine = Math.max(0, lineNumber - 3);
          const endLine = Math.min(lines.length - 1, lineNumber + 3);
          
          for (let i = startLine; i <= endLine; i++) {
            const prefix = i === lineNumber ? '> ' : '  ';
            sourceContext += `${prefix}${i + 1}: ${lines[i]}\n`;
          }
        }
      } catch (err) {
        sourceContext = 'Unable to retrieve source code';
      }
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            url,
            lineNumber: lineNumber + 1,
            columnNumber,
            callstack,
            sourceContext
          }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Error getting location: ${err.message}`
        }]
      };
    }
  }
);

// Add a tool specifically for getting console output
server.tool(
  "get_console_output",
  "Gets the most recent console output from the debugged process",
  {
    limit: z.number().optional().describe("Maximum number of console entries to return. Defaults to 20")
  },
  async ({ limit = 20 }) => {
    try {
      if (!inspector.consoleOutput || inspector.consoleOutput.length === 0) {
        return {
          content: [{
            type: "text",
            text: "No console output captured yet"
          }]
        };
      }

      // Get the most recent console output entries
      const recentOutput = inspector.consoleOutput.slice(-limit);
      const formattedOutput = recentOutput.map(output => {
        const timestamp = new Date(output.timestamp).toISOString();
        return `[${timestamp}] [${output.type}] ${output.message}`;
      }).join('\n');

      return {
        content: [{
          type: "text",
          text: `Console output (most recent ${recentOutput.length} entries):\n\n${formattedOutput}`
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Error getting console output: ${err.message}`
        }]
      };
    }
  }
);

// Start receiving messages on stdin and sending messages on stdout
const transport = new StdioServerTransport();
await server.connect(transport);

console.log("Inspector server ready...");