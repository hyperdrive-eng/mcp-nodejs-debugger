import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from 'ws';
import fetch from 'node-fetch';

// Create an MCP server
const server = new McpServer({
  name: "Inspector",
  version: "1.0.0",
  description: `Advanced Node.js debugger for runtime analysis and troubleshooting. This tool connects to Node.js's built-in Inspector Protocol to provide powerful debugging capabilities directly through Claude Code.

CAPABILITIES:
- Set breakpoints at specific file locations
- Capture and analyze variables and objects in real-time
- Evaluate JavaScript code in the context of the running application
- Track and inspect console output from target application
- Control execution flow (step over, step into, step out, continue)
- View call stacks and execution context
- Examine detailed object properties

SAFE HTTP REQUEST EXAMPLE:
When you need to trigger a route programmatically to hit a breakpoint, use this pattern:

// GOOD: Use http module with callbacks (this preserves the debugging connection)
const http = require('http');
http.get('http://localhost:3000/your-route', res => {
  console.log('Request made, status:', res.statusCode);
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => { console.log('Response:', data); });
}).on('error', e => console.error('Error:', e));

// BAD: Never use fetch() as it will break the debugging connection
// fetch('http://localhost:3000/your-route') ❌ WILL CAUSE DISCONNECTION

REQUIREMENTS:
- Target Node.js application must be running with the --inspect flag: node --inspect yourapp.js
- Debugger will automatically connect to the default port (9229)
- Custom ports can be specified using the retry_connect tool

IMPORTANT NOTE FOR CLAUDE CODE:
- ALWAYS assume the user has already started their Node.js application in debug mode
- NEVER instruct the user to run their Node.js server with the --inspect flag
- If connection issues occur, suggest using retry_connect tool instead of restarting the server

PROACTIVE DEBUGGING STRATEGY:
When troubleshooting issues, follow this optimized debugging workflow:

1. ANALYZE THE PROBLEM:
   - Ask user for error messages and expected behavior
   - Search the codebase to locate relevant files using grep/glob
   - Understand the execution flow that leads to the error

2. SET BREAKPOINTS STRATEGICALLY:
   - Place breakpoints at key locations using set_breakpoint
   - Put breakpoints BEFORE the error occurs to capture the state
   - Consider breakpoints at: initialization, key function entries, error-prone conditions

3. TRIGGER THE CODE EXECUTION:
   - CAUTION: NEVER use fetch() inside nodejs_inspect as this will interrupt the WebSocket debug connection
   - PREFERRED METHOD #1: Provide Claude Code with EXACT curl commands to run in their terminal and execute with bash: curl http://localhost:3000/route
   - PREFERRED METHOD #2: If HTTP requests must be made programmatically, use http module with callbacks:
     
     const http = require('http');
     http.get('http://localhost:3000/route', res => { 
       console.log('Response status:', res.statusCode);
       // Handle response here
     }).on('error', e => console.error(e));
     
   - ALTERNATIVE: Have user navigate to the specific route/URL in their browser while debugger is active
   - ALWAYS provide clear instructions on exactly what will trigger the breakpoint and how to confirm it's working

4. CAPTURE RUNTIME STATE:
   - When breakpoint hits, immediately use inspect_variables to examine the state
   - Check get_console_output to see application logs
   - Retrieve call stack with get_location
   - Use evaluate to test hypotheses about variable state

5. NAVIGATE EXECUTION:
   - Use step_over, step_into, step_out to analyze control flow
   - Use continue to resume until next breakpoint
   - Keep the user informed about what's happening at each step

6. RESOLVE AND VERIFY:
   - Formulate a solution based on runtime analysis
   - Use evaluate or nodejs_inspect to test potential fixes
   - Have user implement the final solution
   - Verify fix works by re-running the code with breakpoints

IMPORTANT NOTES:
- Always try to trigger breakpoints programmatically before asking user to take action
- When user interaction is required, provide EXTREMELY specific instructions
- Take initiative to explore the runtime state thoroughly when breakpoint is hit
- Keep breakpoints active until issue is fully resolved, then clean up using delete_breakpoint
- For performance issues, use evaluate with timing code to measure execution time
- For memory issues, inspect object properties to identify potential memory leaks
- When security issues are suspected, inspect authentication and data validation code paths

OPTIMIZATION TIP: Set multiple strategic breakpoints at once to capture the full execution path leading to an error.`
});

class Inspector {
	constructor(port = 9229, retryOptions = { maxRetries: 5, retryInterval: 1000, continuousRetry: true }) {
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
		this.continuousRetryEnabled = retryOptions.continuousRetry;
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
		// If continuous retry is enabled, we'll keep trying after the initial attempts
		if (this.retryCount < this.retryOptions.maxRetries || this.continuousRetryEnabled) {
			this.retryCount++;
			
			// If we're in continuous retry mode and have exceeded the initial retry count
			if (this.continuousRetryEnabled && this.retryCount > this.retryOptions.maxRetries) {
				// Only log every 10 attempts to avoid flooding the console
				if (this.retryCount % 10 === 0) {
					console.log(`Waiting for debugger connection... (retry ${this.retryCount})`);
				}
			} else {
				console.log(`Retrying connection (${this.retryCount}/${this.retryOptions.maxRetries})...`);
			}
			
			// Use a longer interval for continuous retries to reduce resource usage
			const interval = this.continuousRetryEnabled && this.retryCount > this.retryOptions.maxRetries
				? Math.min(this.retryOptions.retryInterval * 5, 10000) // Max 10 seconds between retries
				: this.retryOptions.retryInterval;
				
			setTimeout(() => this.initialize(), interval);
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

// Create the inspector instance with continuous retry enabled
const inspector = new Inspector(9229, { 
  maxRetries: 5, 
  retryInterval: 1000, 
  continuousRetry: true 
});

// Initialize console output storage
inspector.consoleOutput = [];

// Execute JavaScript code
server.tool(
  "nodejs_inspect",
  "Executes custom JavaScript code directly in the context of the running Node.js application. CRITICAL for proactive debugging: use this to trigger code paths that would hit breakpoints, simulate user actions, inject test data, modify runtime behavior, or extract detailed state information. WARNING: DO NOT use fetch() or similar browser APIs as they will interrupt the WebSocket debugging connection! Instead, use the native http module with callbacks (http.get/http.request) when making HTTP requests programmatically.",
  {
    js_code: z.string().describe("JavaScript code to execute in the context of the running application. Can include any valid JS including async/await, multiple statements, object creation, and function calls. For HTTP requests, use http.get() with callbacks instead of fetch().")
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
  "Places a debugging breakpoint at a specific line in your code to pause execution and inspect state. Code execution will stop exactly at this line when triggered, allowing you to examine variables, call stack, and program state. Always set breakpoints BEFORE the problematic code areas to capture the state leading to issues.",
  {
    file: z.string().describe("Full absolute file path where to set breakpoint (e.g., '/path/to/your/app.js')"),
    line: z.number().describe("Line number for breakpoint (1-based, as shown in code editors)")
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
  "Retrieves and displays all variables and their values in the current execution context when paused at a breakpoint. This is ESSENTIAL after hitting a breakpoint to understand the program state, identify unexpected values, and diagnose issues. Use this immediately when execution pauses to get a complete snapshot of the runtime environment.",
  {
    scope: z.string().optional().describe("Scope to inspect: 'local' for variables in current function/block (default), 'global' for application-wide variables")
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
  "Advances code execution to the next line within the same function scope, executing any function calls as single operations without stepping into them. Use this to progress through code line-by-line while treating function calls as 'black boxes'. When stepping through complex code, this helps you focus on the current function's logic without diving into implementation details of called functions.",
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
  "Advances execution to the next line, but if that line contains a function call, steps into that function and continues debugging there. Essential for diving into function implementations, following the execution path into nested calls, and understanding how data flows between functions. Use this when you suspect an issue exists inside a function being called from the current line.",
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
  "Executes the rest of the current function and pauses at the next line after the function returns to its caller. Perfect for when you've determined a function is working correctly and want to return to the calling context, or when you've stepped into a function accidentally and want to get back to the higher-level code without manually stepping through every remaining line.",
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
  "Resumes normal code execution after being paused at a breakpoint, running at full speed until the next breakpoint is hit or the program terminates. Use this when you've examined the current state and want to let the program run naturally to the next point of interest. This is especially useful when you have multiple breakpoints set up along an execution path to analyze different stages of processing.",
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
  "Removes a specific breakpoint from the debugging session by its ID. Use this to clean up breakpoints that are no longer needed or to remove breakpoints that might be interfering with program flow. Always use list_breakpoints first to get the correct ID of the breakpoint you want to remove.",
  {
    breakpointId: z.string().describe("ID of the breakpoint to remove (get this ID from the list_breakpoints tool)")
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
  "Displays all currently active breakpoints with their IDs, file locations, and line numbers. Use this to keep track of all breakpoints set during a debugging session, verify that breakpoints are set in the intended locations, and obtain breakpoint IDs required for the delete_breakpoint tool. Good practice is to check this after setting new breakpoints to confirm they're registered correctly.",
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
  "Evaluates a JavaScript expression in the context of the paused execution point or global scope. Unlike nodejs_inspect which runs in the global context, this tool evaluates code within the specific context of the current breakpoint, giving access to local variables. Perfect for testing conditions, calculating values, or examining complex objects without modifying the application state.",
  {
    expression: z.string().describe("JavaScript expression to evaluate - can reference local variables at the breakpoint, make function calls, access properties, or perform calculations")
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
  "Provides detailed information about the current execution point when paused at a breakpoint, including file location, line number, call stack, and surrounding code. Use this immediately after a breakpoint is hit to understand exactly where the execution has paused and how it got there. The call stack is particularly valuable for tracing the sequence of function calls leading to the current point.",
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
  "Retrieves recent console.log, console.error, and other console messages from the running application. This is invaluable for seeing runtime outputs, error messages, and debugging information without modifying the code. Check this output regularly during debugging sessions to catch messages that might explain the issue, especially before and after hitting breakpoints.",
  {
    limit: z.number().optional().describe("Maximum number of console entries to return. Defaults to 20. Use larger values to see more historical output.")
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

// Add a tool for manually retrying connection to the Node.js debugger
server.tool(
  "retry_connect",
  "Forces the debugger to attempt reconnection to the Node.js application, which is useful when the target application has restarted or when connecting to a different debugging port. If the standard auto-reconnection isn't working, or you need to connect to a specific port different from the default 9229, use this tool to establish the connection manually. This is especially helpful when troubleshooting connection issues or working with multiple Node.js processes.",
  {
    port: z.number().optional().describe("Optional port to connect to if not using the default 9229. Use this when your Node.js app is running with --inspect=XXXX where XXXX is a custom port")
  },
  async ({ port }) => {
    try {
      // If a new port is specified, update the inspector's port
      if (port && port !== inspector.port) {
        inspector.port = port;
        console.log(`Updated debugger port to ${port}`);
      }
      
      // If already connected, disconnect first
      if (inspector.connected && inspector.ws) {
        inspector.ws.close();
        inspector.connected = false;
      }
      
      // Reset retry count and initialize
      inspector.retryCount = 0;
      inspector.initialize();
      
      return {
        content: [{
          type: "text",
          text: `Attempting to connect to Node.js debugger on port ${inspector.port}...`
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Error initiating connection retry: ${err.message}`
        }]
      };
    }
  }
);

// Start receiving messages on stdin and sending messages on stdout
const transport = new StdioServerTransport();

try {
  await server.connect(transport);
  
  console.log("Inspector server ready...");
  console.log("MCP Debugger started. Connected to Node.js Inspector protocol.");
  console.log("The server will continuously try to connect to any Node.js debugging session on port 9229.");
  console.log("You can start a Node.js app with debugging enabled using: node --inspect yourapp.js");
} catch (error) {
  console.error("MCP server connection error:", error);
  
  // Handle MCP connection closed error specifically
  if (error.code === -32000 && error.message.includes("Connection closed")) {
    // Send a helpful message back to the client
    await transport.sendMessage({
      jsonrpc: "2.0",
      id: null,
      result: {
        content: [{
          type: "text",
          text: `MCP error -32000: Connection closed.\n\nThe connection to the MCP server has been closed. This typically happens when:\n\n1. The Claude Code session has timed out\n2. The client has disconnected\n\nPlease start a new Claude Code or MCP client session and try again.`
        }]
      }
    });
  }
}
