# Ethereum Language Support for DeFi

Ethereum DeFi support for NodeJS applications in VS Code.

## Features

- Hover information for Ethereum addresses with ETH/token balances and dollar values.
- Hover information for token addresses with price, market cap, daily volumes, etc.
- Hover information for ENS names.
- Code lens for Ethereum addresses with Etherscan links for mainnet and testnets.
- Code completion for Ethereum token addresses by name.
- Snippets for DeFi applications such as Uniswap v2 and pTokens.
- Automatic ENS name resolution and reverse resolution.
- Quick fixes to convert addresses to ENS names.
- Diagnostics and quick fixes for checksum failures and non-checksum addresses.

## Setup

To enable full functionality, go to VS Code settings, search for the following settings and enter the required values:
- Code Lens: Enable
- Infura: Enter your Infura Project ID and Project Secret from https://infura.io/
- Amberdata: Enter your Amberdata API key from https://amberdata.io/

The above secrets and API key are optional and are used by the extension to access additional APIs for enhanced display data.

## Structure

```
.
├── client // Language Client
│   ├── src
│   │   └── extension.ts // Language Client entry point
├── package.json // The extension manifest.
└── server // Language Server
    └── src
        └── server.ts // Language Server entry point
```

## Running the project from source

- Run `npm install` in this folder. This installs all necessary npm modules in both the client and server folder
- Open VS Code on this folder.
- Press Ctrl+Shift+B to compile the client and server.
- Switch to the Debug viewlet.
- Select `Launch Client` from the drop down.
- Run the launch config.
- If you want to debug the server as well use the launch configuration `Attach to Server`
- In the [Extension Development Host] instance of VSCode, open a JavaScript or TypeScript source file.
  - Press the VS Code hotkeys for code completion and type "Token" for tokens or "DeFi" for snippets.
  - Define strings with Ethereum addresses, token addresses, or ENS names, and see hover/diagnostic/code lens information.
