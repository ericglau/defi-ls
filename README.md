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
