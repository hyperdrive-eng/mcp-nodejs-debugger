# MCP Node.js Debugger

An MCP server that gives Cursor or Claude Code access to Node.js at runtime to help you debug: [`@hyperdrive-eng/mcp-nodejs-debugger`](https://www.npmjs.com/package/@hyperdrive-eng/mcp-nodejs-debugger).

## Demo

### Cursor

https://github.com/user-attachments/assets/c193a17e-b0e6-4c51-82aa-7f3f0de17e1a

### Claude Code

https://github.com/user-attachments/assets/adb7321b-3a6a-459b-a5c9-df365710d4d8

## Quick start

### Cursor

1. Add to Cursor (`~/.cursor/mcp.json`)

    ![image](https://github.com/user-attachments/assets/132092ab-52d9-4790-84bb-9e9702603390)

    ```diff
    + {
    +   "mcpServers": {
    +   "nodejs-debugger": {
    +      "command": "npx",
    +       "args": ["@hyperdrive-eng/mcp-nodejs-debugger"]
    +     }
    +   }
    + }
    ```

1. Run a Node.js server in [debug mode](https://nodejs.org/en/learn/getting-started/debugging) (i.e. with the `--inspect` flat)

    ```sh
    node --inspect {file.js}
    ```
    
1. Ask Cursor to debug your Node.js server at runtime

    ![image](https://github.com/user-attachments/assets/fa85982b-33ce-41df-ac90-58ce6a73c433)

### Claude Code

1. Add to Claude Code

    ```sh
    claude mcp add nodejs-debugger npx @hyperdrive-eng/mcp-nodejs-debugger
    ```

1. Start Claude Code

    ```sh
    claude
    ╭───────────────────────────────────────────────────────╮
    │ ✻ Welcome to Claude Code research preview!            │
    │                                                       │
    │   /help for help                                      │
    │                                                       │
    │   Found 1 MCP server (use /mcp for status)            │
    ╰───────────────────────────────────────────────────────╯
    ```

2. Run a Node.js server in [debug mode](https://nodejs.org/en/learn/getting-started/debugging) (i.e. with the `--inspect` flat)

    ```sh
    # In another terminal
    node --inspect {file.js}
    ```

3. Ask Claude Code to debug your Node.js server at runtime

    ```sh
    > I'm getting a runtime error in Node.js 

      {YOUR_RUNTIME_ERROR}
      
      Please help me debug this error at runtime using the nodejs-debugger mcp.
    ```
    
## Usage

### Claude Code

1. Add to Claude Code

    ```sh
    claude mcp add nodejs-debugger npx mcp-nodejs-debugger
    ```

1. Verify connection

    ```sh
    > /mcp
      ⎿  MCP Server Status

         • nodejs-debugger: connected
    ```

1. Remove from Claude Code

    ```sh
    claude remove nodejs-debugger
    ```

### Cursor

1. Add to Cursor (`~/.cursor/mcp.json`)

    ```diff
    + {
    +   "mcpServers": {
    +   "nodejs-debugger": {
    +      "command": "npx",
    +       "args": ["@hyperdrive-eng/mcp-nodejs-debugger"]
    +     }
    +   }
    + }
    ```

1. Verify connection:

    ![image](https://github.com/user-attachments/assets/132092ab-52d9-4790-84bb-9e9702603390)

1. Remove from Cursor (`~/.cursor/mcp.json`):

    ```diff
    - {
    -   "mcpServers": {
    -   "nodejs-debugger": {
    -      "command": "npx",
    -       "args": ["@hyperdrive-eng/mcp-nodejs-debugger"]
    -     }
    -   }
    - }
    ```

## Example

### Cursor

1. Run this simple Node.js app: [github.com/mdn/express-locallibrary-tutorial](https://github.com/mdn/express-locallibrary-tutorial):

    ```sh
    node --inspect ./bin/www
    ```

1. Ask Cursor to set a breakpoint

    ![image](https://github.com/user-attachments/assets/fa85982b-33ce-41df-ac90-58ce6a73c433)

    ![image](https://github.com/user-attachments/assets/d24b3423-b7c3-4268-ab86-732371aa047c)

2. Create a book at [`localhost:3000/catalog/book/create`](http://localhost:3000/catalog/book/create)

    ![image](https://github.com/user-attachments/assets/165cb026-7767-417d-a52e-2423e5e5728e)

1. Watch Cursor capture runtime state

    ![image](https://github.com/user-attachments/assets/a7204504-7441-4592-9758-0397086ba724)

### Claude Code

1. Here is a buggy Node.js server:

    ```
    node --inspect index.js
    
    Debugger listening on ws://127.0.0.1:9229/2862f5a2-8618-4516-8429-1248b397e9b4
    
    #######################
    ## THE RUNTIME ERROR ##
    #######################
    MongooseServerSelectionError: Could not connect to any servers in your MongoDB Atlas cluster. One common reason is that you're trying to access the database from an IP that isn't whitelisted. Make sure your current IP address is on your Atlas cluster's IP whitelist: https://www.mongodb.com/docs/atlas/security-whitelist/
        at _handleConnectionErrors (/Users/arthur/Documents/thirdparties/mdn/express-locallibrary-tutorial/node_modules/mongoose/lib/connection.js:1110:11)
        at NativeConnection.openUri (/Users/arthur/Documents/thirdparties/mdn/express-locallibrary-tutorial/node_modules/mongoose/lib/connection.js:1041:11)
        at async main (/Users/arthur/Documents/thirdparties/mdn/express-locallibrary-tutorial/app.js:35:3) {
      reason: TopologyDescription {
        type: 'ReplicaSetNoPrimary',
        servers: Map(3) {
          'ac-8e6hgk7-shard-00-01.cojoign.mongodb.net:27017' => [ServerDescription],
          'ac-8e6hgk7-shard-00-02.cojoign.mongodb.net:27017' => [ServerDescription],
          'ac-8e6hgk7-shard-00-00.cojoign.mongodb.net:27017' => [ServerDescription]
        },
        stale: false,
        compatible: true,
        heartbeatFrequencyMS: 10000,
        localThresholdMS: 15,
        setName: 'atlas-5syy8t-shard-0',
        maxElectionId: null,
        maxSetVersion: null,
        commonWireVersion: 0,
        logicalSessionTimeoutMinutes: null
      },
      code: undefined
    }
    ```

1. Claude Code debugs the Node.js server at runtime:

    ```sh    
    > I'm getting a runtime error connecting to mongoose. Please help me debug by checking the value of 
      the mongodb configs at runtime using the nodejs-debugger mcp.

      ⏺ I'll help you debug the mongoose connection issue using the Node.js debugger. Let's first understand where the
      MongoDB connection is configured.
    
      ⏺ Search(pattern: "**/*.js")…
        ⎿  Found 100 files
  
      ⏺ Let's set a breakpoint at the mongoose connection point and continue:
  
      ⏺ nodejs-debugger:set_breakpoint (MCP)(file:                                                                         …
            "/Users/arthur/Documents/thirdparties/mdn/express-locallibrary-tutorial/app.js",
             line: 35)
        ⎿  Breakpoint set successfully. ID:
           2:34:0:file:///Users/arthur/Documents/thirdparties/mdn/express-locallibrary-tutorial/app\.js
      
      ⏺ Let's list all our breakpoints:
      
      ⏺ nodejs-debugger:list_breakpoints (MCP)
        ⎿  [
             {
               "file": "/Users/arthur/Documents/thirdparties/mdn/express-locallibrary-tutorial/app.js",
               "line": 35,
               "id": "2:34:0:file:///Users/arthur/Documents/thirdparties/mdn/express-locallibrary-tutorial/app\\.js"
             }
           ]
      
      ⏺ Let's try to execute a specific piece of code to check the connection variables:
  
      ⏺ nodejs-debugger:nodejs_inspect (MCP)(js_code: "// Get the mongoose module and inspect connection\nconst mongoose = …
                                            require('mongoose');\nconsole.log('Current mongoose version:',
                                            mongoose.version);\nconsole.log('Current mongoose connection state:',
                                            mongoose.connection.readyState);\n// Log connection string safely (without
                                            password)\nconst connectionString = process.env.MONGODB_URI || \n
                                            \"mongodb+srv://cooluser:coolpassword@cluster0.cojoign.mongodb.net/local_library?retryWr
                                            ites=true&w=majority&appName=Cluster0\";\nconsole.log('Connection string
                                            (masked):', connectionString.replace(/(?<=mongodb\\+srv:\\/\\/\\w+:)(.+?)(?=@)/,
                                             '*****'));")
      
        ⎿  Console output:
           [log] Current mongoose version: 8.9.5
           [log] Current mongoose connection state: 0
           [log] Connection string (masked): mongodb+srv://cooluser:coolpassword@cluster0.cojoign.mongodb.net/local_library?retryWri
           tes=true&w=majority&appName=Cluster0

      ⏺ The runtime error you're seeing in your application is related to MongoDB
        Atlas connection issues. Based on your error message, the problem is:
      
        1. You're using placeholder credentials ("cooluser:coolpassword")
      
        To fix this, you have two options:
      
        1. Use a local MongoDB instance by changing line 29-30 in app.js to:
        const dev_db_url = "mongodb://127.0.0.1:27017/local_library";
        2. Or correctly set up MongoDB Atlas:
          - Log into Atlas at https://cloud.mongodb.com
          - Go to Network Access and add your current IP to whitelist
          - Create proper database credentials
          - Update the connection string with real credentials
      
        Which option would you like to proceed with?
    ```
