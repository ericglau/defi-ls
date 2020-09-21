/* --------------------------------------------------------------------------------------------
 * Copyright for portions from https://github.com/microsoft/vscode-extension-samples/tree/master/lsp-sample 
 * are held by (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * 
 * Copyright (c) 2020 Eric Lau. All rights reserved. 
 * Licensed under the Eclipse Public License v2.0
 * ------------------------------------------------------------------------------------------ */

import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	CodeLens,
	CodeLensParams,
	CodeAction,
	CodeActionKind,
	CodeActionParams,
	CodeActionContext,
	Command,
	WorkspaceEdit,
	HoverParams,
	Hover,
	MarkedString,
	MarkupContent,
	MarkupKind
} from 'vscode-languageserver';

import {
	TextDocument, Range, TextEdit
} from 'vscode-languageserver-textdocument';

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

const NAME: string = 'Ethereum DeFi Language Support';

const DIAGNOSTIC_TYPE_NOT_VALID_ADDRESS: string = 'NotValidAddress';
const DIAGNOSTIC_TYPE_NOT_CHECKSUM_ADDRESS: string = 'NotChecksumAddress';
const DIAGNOSTIC_TYPE_CONVERT_TO_ENS_NAME: string = 'ConvertENSName';
const DIAGNOSTIC_TYPE_CONVERT_FROM_ENS_NAME: string = 'ConvertFromENSName';
const DIAGNOSTIC_TYPE_GENERATE_ABI: string = 'GenerateABI';

const CODE_LENS_TYPE_ETH_ADDRESS: string = 'EthAddress';
const CODE_LENS_TYPE_ETH_PRIVATE_KEY: string = 'EthPrivateKey';

const MAINNET: string = 'mainnet';
const ROPSTEN: string = 'ropsten';
const KOVAN: string = 'kovan';
const RINKEBY: string = 'rinkeby';
const GOERLI: string = 'goerli';
const NETWORKS : string[] = [ MAINNET, ROPSTEN, KOVAN, RINKEBY, GOERLI];

const DEFAULT_TOKEN_LIST_JSON_URL = 'https://gateway.ipfs.io/ipns/tokens.uniswap.org'

var Web3 = require('web3');
var web3 = new Web3();
var ENS = require('ethereum-ens');
var Wallet = require('ethereumjs-wallet')
var EthUtil = require('ethereumjs-util')
const {indexOfRegex, lastIndexOfRegex} = require('index-of-regex')
var request = require("request-promise")
var BigNumber = require('big-number');

// to be defined at runtime
var web3provider: any;
var ens: { 
	resolver: (arg0: string) => { (): any; new(): any; addr: { (): Promise<any>; new(): any; }; };
	 reverse: (arg0: string) => { (): any; new(): any; name: { (): Promise<any>; new(): any; }; };  
};
var amberdataApiKeySetting: string = "";
var etherscanApiKeySetting: string = "";
var cacheDurationSetting: number;
var tokenListUrlSetting: string = "";

let ensCache : Map<string, string> = new Map();
let ensReverseCache : Map<string, string> = new Map();
let tokenCache : Map<string, Token> = new Map();
let topTokensCache : Map<string, Token> = new Map();
let addressMarkdownCache : Map<string, [Number, string]> = new Map(); // map address to [timestamp, markdown]
let abiCache : Map<string, [Number, JSON]> = new Map(); // map address to [timestamp, ABI JSON]

connection.onInitialize((params: InitializeParams) => {
	let capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we will fall back using global settings
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that the server supports code completion
			completionProvider: {
				resolveProvider: true
			},
			codeLensProvider : {
				resolveProvider: true
			},
			codeActionProvider : {
				codeActionKinds : [ CodeActionKind.QuickFix ]
			},
			hoverProvider : {
				workDoneProgress: false
			}
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

interface DefiSettings {
	maxNumberOfProblems: number;
	infuraProjectId: string;
	infuraProjectSecret: string;
	amberdataApiKey: string;
	etherscanApiKey: string;
	cacheDuration: number;
	tokenListJsonUrl: string;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: DefiSettings = { maxNumberOfProblems: 100, infuraProjectId: "", infuraProjectSecret: "", amberdataApiKey: "", etherscanApiKey: "", cacheDuration: 60000, tokenListJsonUrl: DEFAULT_TOKEN_LIST_JSON_URL };
let globalSettings: DefiSettings = defaultSettings;

// Cache the settings of all open documents
let documentSettings: Map<string, Thenable<DefiSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <DefiSettings>(
			(change.settings.defi || defaultSettings)
		);
	}

	// Clear data caches
	ensCache.clear();
	ensReverseCache.clear();
	tokenCache.clear();
	topTokensCache.clear();
	addressMarkdownCache.clear();

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<DefiSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'defi'
		});
		documentSettings.set(resource, result);
	}
	return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {

	// In this simple example we get the settings for every validate run.
	let settings = await getDocumentSettings(textDocument.uri);

	if (settings.infuraProjectId === "" || settings.infuraProjectId === "") {
		connection.console.warn("Infura project ID and/or secret has not been set. Obtain them from https://infura.io/ and set them in the VS Code settings by searching for \"Infura\".");
	} else {
		// set up infura and ENS
		web3provider = new Web3.providers.HttpProvider('https://:' + settings.infuraProjectSecret + '@mainnet.infura.io/v3/' + settings.infuraProjectId);
		ens = new ENS(web3provider);
		connection.console.info("Using Infura for web3.");
	}

	if (settings.amberdataApiKey === "") {
		connection.console.warn("Amberdata.io API key has not been set. Obtain one from https://amberdata.io/ and set the in them VS Code settings by searching for \"Amberdata\".");
	} else {
		amberdataApiKeySetting = settings.amberdataApiKey;
		if (web3provider === undefined || ens === undefined) {
			// Use Amberdata for web3 if Infura is not set
			web3provider = new Web3.providers.HttpProvider('https://rpc.web3api.io?x-api-key=' + amberdataApiKeySetting);
			ens = new ENS(web3provider)
			connection.console.info("Using Amberdata for web3.");
		}
		connection.console.info("Using Amberdata for address and token data.");
	}

	if (settings.etherscanApiKey === "") {
		connection.console.warn("Etherscan.io API key has not been set. Obtain one from https://etherscan.io/ and set the in them VS Code settings by searching for \"Etherscan\".");
	} else {
		etherscanApiKeySetting = settings.etherscanApiKey;
		connection.console.info("Using Etherscan for contract ABIs.");
	}

	if (settings.tokenListJsonUrl === "") {
		connection.console.error("No Token List has been configured.  Configure a Token List URL in VS Code settings for Ethereum DeFi.");
	} else {
		tokenListUrlSetting = settings.tokenListJsonUrl;
		connection.console.info("Using Token List from " + tokenListUrlSetting);
	}

	if (web3provider === undefined) {
		connection.console.error("No web3 connection has been configured.  Configure Infura and/or Amberdata keys in VS Code settings for Ethereum DeFi.");
	}

	if (settings.cacheDuration === undefined || settings.cacheDuration < 0) {
		cacheDurationSetting = 60000;
	} else {
		cacheDurationSetting = settings.cacheDuration;
	}

	let diagnostics: Diagnostic[] = [];

	let possibleEthereumAddresses : StringLocation[] = findPossibleEthereumAddresses(textDocument);
	let problems = 0;
	for (var i = 0; i < possibleEthereumAddresses.length; i++) {
		let element : StringLocation = possibleEthereumAddresses[i];
		if (problems < settings.maxNumberOfProblems) {
			problems++;
			if (!isValidEthereumAddress(element.content)) {
				// Invalid checksum
				addDiagnostic(element, `${element.content} is not a valid Ethereum address`, 'The string appears to be an Ethereum address but fails checksum.', DiagnosticSeverity.Error, DIAGNOSTIC_TYPE_NOT_VALID_ADDRESS);
			} else {
				// Not a checksum address
				var checksumAddress = web3.utils.toChecksumAddress(element.content);
				if (element.content != checksumAddress) {
					addDiagnostic(element, `${element.content} is not a checksum address`, 'Use a checksum address as a best practice to ensure the address is valid.', DiagnosticSeverity.Warning, DIAGNOSTIC_TYPE_NOT_CHECKSUM_ADDRESS + checksumAddress);
				}

				// Hint to convert to ENS name
				let ensName : string = await reverseENSLookup(element.content);
				if (ensName !== "") {
					addDiagnostic(element, `${element.content} can be converted to its ENS name \"${ensName}\"`, 'Convert the Ethereum address to its ENS name.', DiagnosticSeverity.Hint, DIAGNOSTIC_TYPE_CONVERT_TO_ENS_NAME + ensName);
				}

				// Infer if it's possibly a contract, then show quickfix to generate contract ABI
				if (await isContract(element.content)) {
					addDiagnostic(element, `Generate contract ABI`, 'Highlight this address and use the tooltip to generate contract ABI from Etherscan', DiagnosticSeverity.Hint, DIAGNOSTIC_TYPE_GENERATE_ABI + element.content);
				}
			}
		}
	}

	let possibleEnsNames : StringLocation[] = findPossibleENSNames(textDocument);
	for (var i = 0; i < possibleEnsNames.length; i++) {
		let element : StringLocation = possibleEnsNames[i];
		if (problems < settings.maxNumberOfProblems) {
			// Hint to convert to Ethereum address
			let ensAddress : string = await ENSLookup(element.content);
			if (ensAddress !== "") {
				problems++;
				addDiagnostic(element, `${element.content} can be converted to its Ethereum address`, 'Convert the ENS name to its Ethereum address.', DiagnosticSeverity.Hint, DIAGNOSTIC_TYPE_CONVERT_FROM_ENS_NAME + ensAddress);
			}
		}
	}

	// Send the computed diagnostics to VSCode.
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });

	function addDiagnostic(element: StringLocation, message: string, details: string, severity: DiagnosticSeverity, code: string | undefined) {
		let diagnostic: Diagnostic = {
			severity: severity,
			range: element.range,
			message: message,
			source: NAME,
			code: code
		};
		if (hasDiagnosticRelatedInformationCapability) {
			diagnostic.relatedInformation = [
				{
					location: {
						uri: textDocument.uri,
						range: Object.assign({}, diagnostic.range)
					},
					message: details
				}
			];
		}
		diagnostics.push(diagnostic);
	}
}

async function isContract(address : string) : Promise<boolean> {
	if (web3provider === undefined) {
		return false;
	}
	let result : boolean = false;
	let web3connection = new Web3(web3provider);
	let code = await web3connection.eth.getCode(address).then(function (code: string) {
		if (code !== "0x") {
			result = true;
		}
	}).catch((e: string) => connection.console.log("Could not check whether address " + address + " is a contract due to error: " + e));
	return result;
}

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('We received an file change event');
});

export interface Token {
	name: string;
	symbol: string;
	address: string;
	marketData: MarketData | undefined;
	lastUpdated: Number;
}

export interface MarketData {
	marketCap: string | undefined;
	price: string | undefined;
	circulatingSupply: string | undefined;
	totalSupply: string | undefined;
	tradeVolume: string | undefined;
}

async function getTopTokens() {
	if (topTokensCache.size > 0) {
		for (var entry of topTokensCache.entries()) {
			var value = entry[1];
			if (value.lastUpdated > (Date.now() - cacheDurationSetting)) {
				// top tokens cache is not stale
				return topTokensCache;
			}
		}
	}

	let topTokensMap : Map<string, Token> = new Map();

	// Get tokens from Tokens List json
	var tokensListOpts = {
		method: 'GET',
		url: tokenListUrlSetting
		};

	await request(tokensListOpts, async function (error: string | undefined, response: any, body: any) {
		if (error) {
			connection.console.log("Request error getting tokens list: " + error);
			return;
		}
		var result = JSON.parse(body);
		if (result !== undefined && result.tokens !== undefined ) {
			result.tokens.forEach((element: { name: string, symbol:string, address:string, chainId:string }) => {
				if (element.chainId !== undefined && element.chainId == "1") { // Include mainnet tokens only
					let token : Token = {
						name: element.name,
						symbol: element.symbol,
						address: getChecksumAddress(element.address),
						marketData: undefined,
						lastUpdated: Date.now()
					}
					topTokensMap.set(token.address, token)	
				}
			});
		}
	}).catch((error: string) => { connection.console.log("Error getting tokens list: " + error) });
	
	topTokensCache = topTokensMap;
	return topTokensMap;
}

// This handler provides the initial list of the completion items.
connection.onCompletion(
	async (_textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[]> => {
		// The passed parameter contains the position of the text document in
		// which code complete got requested.

		let completionItems : CompletionItem[] = [];

		// Token completion items
		let tokens : Map<string, Token> = await getTopTokens();
		for (var entry of tokens.entries()) {
			var address = entry[0],
				token = entry[1];
			let textEdit : TextEdit = { 
				range: {
					start: _textDocumentPosition.position,
					end: _textDocumentPosition.position
				},  
				newText: getChecksumAddress(token.address)
			};
			let completionItem : CompletionItem = 
			{
				label: `Token: ${token.name} (${token.symbol})`,
				kind: CompletionItemKind.Value,
				data: token,
				textEdit: textEdit
			}			
			completionItems.push(completionItem);
		}

		// Snippets
		// Uniswap token
		{
			let snippet : string = 
				"const token = new Token(ChainId.MAINNET, '0xc0FFee0000000000000000000000000000000000', 18, 'HOT', 'Caffeine')\n";
			let imports = "import { ChainId, Token, TokenAmount, Pair, Trade, TradeType, Route } from '@uniswap/sdk'\n";
			insertSnippet(_textDocumentPosition, snippet, completionItems, imports, "DeFi: Uniswap SDK - Token", 0);
		}
		// Uniswap pair
		{
			let snippet : string = 
				"const HOT = new Token(ChainId.MAINNET, '0xc0FFee0000000000000000000000000000000000', 18, 'HOT', 'Caffeine')\n"+
				"const NOT = new Token(ChainId.MAINNET, '0xDeCAf00000000000000000000000000000000000', 18, 'NOT', 'Caffeine')\n"+
				"\n"+
				"const pair = new Pair(new TokenAmount(HOT, '2000000000000000000'), new TokenAmount(NOT, '1000000000000000000'))\n";
			let imports = "import { ChainId, Token, TokenAmount, Pair, Trade, TradeType, Route } from '@uniswap/sdk'\n";
			insertSnippet(_textDocumentPosition, snippet, completionItems, imports, "DeFi: Uniswap SDK - Pair", 1);
		}
		// Uniswap route
		{
			let snippet : string = 
				"const HOT = new Token(ChainId.MAINNET, '0xc0FFee0000000000000000000000000000000000', 18, 'HOT', 'Caffeine')\n"+
				"const NOT = new Token(ChainId.MAINNET, '0xDeCAf00000000000000000000000000000000000', 18, 'NOT', 'Caffeine')\n"+
				"const HOT_NOT = new Pair(new TokenAmount(HOT, '2000000000000000000'), new TokenAmount(NOT, '1000000000000000000'))\n"+
				"\n"+
				"const route = new Route([HOT_NOT], NOT)\n";
			let imports = "import { ChainId, Token, TokenAmount, Pair, Trade, TradeType, Route } from '@uniswap/sdk'\n";
			insertSnippet(_textDocumentPosition, snippet, completionItems, imports, "DeFi: Uniswap SDK - Route", 2);
		}
		// Uniswap trade
		{
			let snippet : string = 
				"const HOT = new Token(ChainId.MAINNET, '0xc0FFee0000000000000000000000000000000000', 18, 'HOT', 'Caffeine')\n"+
				"const NOT = new Token(ChainId.MAINNET, '0xDeCAf00000000000000000000000000000000000', 18, 'NOT', 'Caffeine')\n"+
				"const HOT_NOT = new Pair(new TokenAmount(HOT, '2000000000000000000'), new TokenAmount(NOT, '1000000000000000000'))\n"+
				"const NOT_TO_HOT = new Route([HOT_NOT], NOT)\n"+
				"\n"+
				"const trade = new Trade(NOT_TO_HOT, new TokenAmount(NOT, '1000000000000000'), TradeType.EXACT_INPUT)\n";
			let imports = "import { ChainId, Token, TokenAmount, Pair, Trade, TradeType, Route } from '@uniswap/sdk'\n";
			insertSnippet(_textDocumentPosition, snippet, completionItems, imports, "DeFi: Uniswap SDK - Trade", 3);
		}
		// pTokens
		{
			let snippet : string = 
				"const ptokens = new pTokens({\n"+
				"	pbtc: {\n"+
				"		ethPrivateKey: 'Eth private key',\n"+
				"		ethProvider: 'Eth provider',\n"+
				"		btcNetwork: 'testnet',  //'testnet' or 'bitcoin', default 'testnet'\n"+
				"		defaultEndpoint: 'https://......' //optional\n"+
				"	}\n"+
				"})\n";
			let imports = "import { pTokens } from 'ptokens'\n";
			insertSnippet(_textDocumentPosition, snippet, completionItems, imports, "DeFi: pTokens SDK", 4);
		}
		// pTokens (web3)
		{
			let snippet : string = 
				"if (window.web3) {\n"+
				"	const ptokens = new pTokens({\n"+
				"		pbtc: {\n"+
				"			ethProvider: window.web3.currentProvider,\n"+
				"			btcNetwork: 'bitcoin'\n"+
				"		}\n"+
				"	})\n"+
				"} else {\n"+
				"	console.log('No web3 detected')\n"+
				"}\n";
			let imports = "import { pTokens } from 'ptokens'\n";
			insertSnippet(_textDocumentPosition, snippet, completionItems, imports, "DeFi: pTokens SDK - web3", 5);
		}
		// pTokens (pBTC deposit address)
		{
			let snippet : string = 
				"const depositAddress = await ptokens.pbtc.getDepositAddress(ethAddress)\n"+
				"console.log(depositAddress.toString())\n"+
				"\n"+
				"//fund the BTC address just generated (not ptokens.js stuff)\n"+
				"\n"+
				"depositAddress.waitForDeposit()\n"+
				"	.once('onBtcTxBroadcasted', tx => ... )\n"+
				"	.once('onBtcTxConfirmed', tx => ...)\n"+
				"	.once('onNodeReceivedTx', tx => ...)\n"+
				"	.once('onNodeBroadcastedTx', tx => ...)\n"+
				"	.once('onEthTxConfirmed', tx => ...)\n"+
				"	.then(res => ...))\n";
			let imports = "import { pTokens } from 'ptokens'\n";
			insertSnippet(_textDocumentPosition, snippet, completionItems, imports, "DeFi: pTokens SDK - pBTC deposit address", 6);
		}
		{
			let snippet : string = 
				"const ERC_20_ABI = [{\"constant\":true,\"inputs\":[],\"name\":\"name\",\"outputs\":[{\"name\":\"\",\"type\":\"string\"}],\"payable\":false,\"stateMutability\":\"view\",\"type\":\"function\"},{\"constant\":false,\"inputs\":[{\"name\":\"_spender\",\"type\":\"address\"},{\"name\":\"_value\",\"type\":\"uint256\"}],\"name\":\"approve\",\"outputs\":[{\"name\":\"\",\"type\":\"bool\"}],\"payable\":false,\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"constant\":true,\"inputs\":[],\"name\":\"totalSupply\",\"outputs\":[{\"name\":\"\",\"type\":\"uint256\"}],\"payable\":false,\"stateMutability\":\"view\",\"type\":\"function\"},{\"constant\":false,\"inputs\":[{\"name\":\"_from\",\"type\":\"address\"},{\"name\":\"_to\",\"type\":\"address\"},{\"name\":\"_value\",\"type\":\"uint256\"}],\"name\":\"transferFrom\",\"outputs\":[{\"name\":\"\",\"type\":\"bool\"}],\"payable\":false,\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"constant\":true,\"inputs\":[],\"name\":\"decimals\",\"outputs\":[{\"name\":\"\",\"type\":\"uint8\"}],\"payable\":false,\"stateMutability\":\"view\",\"type\":\"function\"},{\"constant\":true,\"inputs\":[{\"name\":\"_owner\",\"type\":\"address\"}],\"name\":\"balanceOf\",\"outputs\":[{\"name\":\"balance\",\"type\":\"uint256\"}],\"payable\":false,\"stateMutability\":\"view\",\"type\":\"function\"},{\"constant\":true,\"inputs\":[],\"name\":\"symbol\",\"outputs\":[{\"name\":\"\",\"type\":\"string\"}],\"payable\":false,\"stateMutability\":\"view\",\"type\":\"function\"},{\"constant\":false,\"inputs\":[{\"name\":\"_to\",\"type\":\"address\"},{\"name\":\"_value\",\"type\":\"uint256\"}],\"name\":\"transfer\",\"outputs\":[{\"name\":\"\",\"type\":\"bool\"}],\"payable\":false,\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"constant\":true,\"inputs\":[{\"name\":\"_owner\",\"type\":\"address\"},{\"name\":\"_spender\",\"type\":\"address\"}],\"name\":\"allowance\",\"outputs\":[{\"name\":\"\",\"type\":\"uint256\"}],\"payable\":false,\"stateMutability\":\"view\",\"type\":\"function\"},{\"payable\":true,\"stateMutability\":\"payable\",\"type\":\"fallback\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":true,\"name\":\"owner\",\"type\":\"address\"},{\"indexed\":true,\"name\":\"spender\",\"type\":\"address\"},{\"indexed\":false,\"name\":\"value\",\"type\":\"uint256\"}],\"name\":\"Approval\",\"type\":\"event\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":true,\"name\":\"from\",\"type\":\"address\"},{\"indexed\":true,\"name\":\"to\",\"type\":\"address\"},{\"indexed\":false,\"name\":\"value\",\"type\":\"uint256\"}],\"name\":\"Transfer\",\"type\":\"event\"}];";
			insertSnippet(_textDocumentPosition, snippet, completionItems, undefined, "DeFi: ERC20 Contract ABI", 7);
		}


		return completionItems;
	}
);

function insertSnippet(_textDocumentPosition: TextDocumentPositionParams, snippetText: string, completionItems: CompletionItem[], imports: string | undefined, label: string, sortOrder: number) {
	let textEdit: TextEdit = {
		range: {
			start: _textDocumentPosition.position,
			end: _textDocumentPosition.position
		},
		newText: snippetText
	};
	let completionItem: CompletionItem = {
		label: label,
		kind: CompletionItemKind.Snippet,
		data: undefined,
		textEdit: textEdit,
		sortText: String(sortOrder)
	};
	// check if imports should be added
	let textDocument = documents.get(_textDocumentPosition.textDocument.uri)
	let textDocumentContents = textDocument?.getText()
	if (imports !== undefined && (textDocumentContents === undefined || !String(textDocumentContents).includes(imports))) {
		let additionalTextEdit = {
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 0 }
			},
			newText: imports
		};
		completionItem.additionalTextEdits = [additionalTextEdit]
	}

	completionItems.push(completionItem);
}

function getChecksumAddress(address: string) {
	try {
		return web3.utils.toChecksumAddress(address)
	} catch(e) {
		connection.console.log("Error getting checksum address: " + e);
		return address;
	}
}

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	async (item: CompletionItem): Promise<CompletionItem> => {
		if (<Token>item.data !== undefined) {
			let token : Token = item.data;
			item.detail = `${token.address}`;
			let markdown : MarkupContent = {
				kind: MarkupKind.Markdown,
				value: 
					await getMarkdownForToken(token)
			};
			item.documentation = markdown;
		}
		return item;
	}
);

export interface StringLocation {
    range: Range;
    content: string;
}

function numberFormat(amount: string, decimals: number) : string {
	const numberFormat = new Intl.NumberFormat('en-US', {
		minimumFractionDigits: decimals
	})
	try {
		return numberFormat.format(Number(amount))
	} catch (e) {
		return amount;
	}
}

function dollarFormat(amount: string) : string {
	const dollarFormat = new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 2
	})
	const subDollarFormat = new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 8
	})
	try {
		if (Number(amount) < 0.01) {
			return subDollarFormat.format(Number(amount))
		} else {
			return dollarFormat.format(Number(amount))
		}		
	} catch (e) {
		return amount;
	}
}

async function getMarkdownForToken(token: Token): Promise<string> {
	// Get tokens from Tokens List json
	if (token.marketData === undefined || token.lastUpdated <= (Date.now() - cacheDurationSetting)) {
		var tokenMarketOptions = {
			method: 'GET',
			url: 'https://api.coingecko.com/api/v3/coins/ethereum/contract/' + token.address
			};

		await request(tokenMarketOptions, async function (error: string | undefined, response: any, body: any) {
			if (error) {
				connection.console.log("Request error getting token market information from Coingecko: " + error);
				return;
			}
			var result = JSON.parse(body);
			if (result !== undefined && result.market_data !== undefined) {
				let marketData : MarketData = {
					price: result.market_data.current_price.usd,
					tradeVolume: result.market_data.total_volume.usd,
					circulatingSupply: result.market_data.circulating_supply,
					totalSupply: result.market_data.total_supply,
					marketCap: result.market_data.market_cap.usd
				}
				token.marketData = marketData;
			}
		}).catch((error: string) => { connection.console.log("Error getting token market information from Coingecko: " + error) });
	}

	var buf = `**Token: ${token.name} (${token.symbol})**\n\n`;
	if (token.marketData !== undefined) {
		if (token.marketData.price !== undefined) {
			buf += `**Price:** ${dollarFormat(token.marketData.price)} USD  \n`;
		}
		if (token.marketData.marketCap !== undefined) {
			buf += `**Market Cap:** ${dollarFormat(token.marketData.marketCap)} USD  \n`;
		}
		if (token.marketData.circulatingSupply !== undefined) {
			buf += `**Circulating Supply:** ${numberFormat(token.marketData.circulatingSupply, 0)}  \n`;
		}
		if (token.marketData.totalSupply !== undefined) {
			buf += `**Total Supply:** ${numberFormat(token.marketData.totalSupply, 0)}  \n`;
		}
		if (token.marketData.tradeVolume !== undefined) {
			buf += `**Trading Volume (Daily):** ${dollarFormat(token.marketData.tradeVolume)} USD  \n`;
		}
	}

	return buf;
}

// find all possible Ethereum addresses
function findPossibleEthereumAddresses(textDocument: TextDocument) : StringLocation[] {
	let text = textDocument.getText();
	let pattern = /0x[0-9a-fA-F]{40}\b/g;  // 0x then 40 hex chars then non hex char
	let m: RegExpExecArray | null;

	let problems = 0;
	let locations: StringLocation[] = [];
	while ((m = pattern.exec(text)) && problems < 100 /*settings.maxNumberOfProblems*/) {
		let location: StringLocation = {
			range: {
				start: textDocument.positionAt(m.index),
				end: textDocument.positionAt(m.index + m[0].length)
			},
			content: m[0] // Possible location
		};
		locations.push(location);
	}
	return locations;
}

// find all possible ENS names
function findPossibleENSNames(textDocument: TextDocument) : StringLocation[] {
	let text = textDocument.getText();
	let pattern = /["'][\w\d.]+[.][\w\d]{3}["']/g;  // quotes surrounding any string with one or more dots, and 3 letter suffix
	let m: RegExpExecArray | null;

	let problems = 0;
	let locations: StringLocation[] = [];
	while ((m = pattern.exec(text)) && problems < 100 /*settings.maxNumberOfProblems*/) {
		m[0] = m[0].substring(1, m[0].length - 1) // remove quotes
		let location: StringLocation = {
			range: {
				start: textDocument.positionAt(m.index + 1),
				end: textDocument.positionAt(m.index + 1 + m[0].length)
			},
			content: m[0] // Possible location
		};
		locations.push(location);
	}
	return locations;
}

function isValidEthereumAddress(address: string) {
	return web3.utils.isAddress(address)
}

function findPossiblePrivateKeys(textDocument: TextDocument) : StringLocation[] {
	let text = textDocument.getText();
	let pattern = /[0-9a-fA-F]{64}\b/g;  // 64 hex chars then non hex char
	let m: RegExpExecArray | null;

	let problems = 0;
	let locations: StringLocation[] = [];
	while ((m = pattern.exec(text)) && problems < 100 /*settings.maxNumberOfProblems*/) {
		let location: StringLocation = {
			range: {
				start: textDocument.positionAt(m.index),
				end: textDocument.positionAt(m.index + m[0].length)
			},
			content: normalizeHex(m[0]) // 0x prepended private key
		};
		locations.push(location);
	}
	return locations;
}

function isPrivateKey(possiblePrivateKey: string) {
	try {
		var privateKeyBuffer = EthUtil.toBuffer(possiblePrivateKey)
		Wallet.fromPrivateKey(privateKeyBuffer)
	} catch(e) {
		return false;
	}
	return true;
}

// append 0x to the front of a hex string if it doesn't start with it
function normalizeHex(hex:string) : string {
	if (!hex.startsWith("0x")) {
		return "0x" + hex;
	}
	return hex;
}

function toPublicKey(privateKey: string) : string {
	return web3.eth.accounts.privateKeyToAccount(privateKey).address;
}

// Handle code lens requests
connection.onCodeLens(
	async (_params: CodeLensParams): Promise<CodeLens[]> => {
		let textDocument = documents.get(_params.textDocument.uri)
		if (typeof textDocument !== 'undefined') {
			let codeLenses: CodeLens[] = [];

			// Ethereum addresses
			let possibleEthereumAddresses : StringLocation[] = findPossibleEthereumAddresses(textDocument);
			possibleEthereumAddresses.forEach( (element) => {
				if (isValidEthereumAddress(element.content)) {
					pushEthereumAddressCodeLenses(CODE_LENS_TYPE_ETH_ADDRESS, element.range, element.content, codeLenses);
				}
			});

			// Private keys to public addresses
			let possiblePublicKeys : StringLocation[] = findPossiblePrivateKeys(textDocument);
			possiblePublicKeys.forEach( (element) => {
				if (isPrivateKey(element.content)) {
					pushEthereumAddressCodeLenses(CODE_LENS_TYPE_ETH_PRIVATE_KEY, element.range, toPublicKey(element.content), codeLenses);
				}
			});

			// ENS names from string literals
			let possibleEnsNames : StringLocation[] = findPossibleENSNames(textDocument);
			for (let i = 0; i < possibleEnsNames.length; i++) {
				let element : StringLocation = possibleEnsNames[i];
				let ensAddress : string = await ENSLookup(element.content);
				if (ensAddress !== "") {
					pushEthereumAddressCodeLenses(CODE_LENS_TYPE_ETH_ADDRESS, element.range, ensAddress, codeLenses);
				}
			}
			possibleEnsNames.forEach( async (element) => {

			});

			// return
			return codeLenses;
		} else {
			return [];
		}
	}
);

function pushEthereumAddressCodeLenses(codeLensType: string, range: Range, content: string, codeLenses: CodeLens[]) {
	NETWORKS.forEach( (network) => {
		let codeLens: CodeLens = { 
			range: range, 
			data: [codeLensType, network, content] 
		};
		codeLenses.push(codeLens);	
	});
}

connection.onCodeLensResolve(
	async (codeLens: CodeLens): Promise<CodeLens> => {
		let codeLensType = codeLens.data[0];
		let network = codeLens.data[1];
		let codeLensData = codeLens.data[2];
		let address : string = codeLensData.toString();
		if (network === MAINNET) {
			// reverse ENS lookup
			let ensName : string = await reverseENSLookup(address);
			// token lookup
			let token : Token | undefined = await getToken(address);
			
			let prefix = "";
			if (ensName != "") {
				prefix += ensName + " | ";
			}
			let isToken : boolean = false;
			if (token !== undefined) {
				isToken = true;
				prefix += getTokenName(token) + " | ";
			}

			if (codeLensType === CODE_LENS_TYPE_ETH_ADDRESS) {
				codeLens.command = Command.create(prefix + "Ethereum " + (isToken?"token":"address") + " (mainnet): " + address, "etherscan.show.url", "https://etherscan.io/address/" + address);
			} else if (codeLensType === CODE_LENS_TYPE_ETH_PRIVATE_KEY) {
				codeLens.command = Command.create(prefix + "Private key for Ethereum " + (isToken?"token":"address") + " (mainnet): " + address, "etherscan.show.url", "https://etherscan.io/address/" + address);
			}	
		} else if (network === ROPSTEN) {
			codeLens.command = Command.create("(ropsten)", "etherscan.show.url", "https://ropsten.etherscan.io/address/" + address);
		} else if (network === KOVAN) {
			codeLens.command = Command.create("(kovan)", "etherscan.show.url", "https://kovan.etherscan.io/address/" + address);
		} else if (network === RINKEBY) {
			codeLens.command = Command.create("(rinkeby)", "etherscan.show.url", "https://rinkeby.etherscan.io/address/" + address);
		} else if (network === GOERLI) {
			codeLens.command = Command.create("(goerli)", "etherscan.show.url", "https://goerli.etherscan.io/address/" + address);
		}
		return codeLens;
	}
);

function getTokenName(token : Token) {
	return `${token.name} (${token.symbol})`;
}

connection.onCodeAction(
	async (_params: CodeActionParams): Promise<CodeAction[]> => {
		let codeActions : CodeAction[] = [];

		let textDocument = documents.get(_params.textDocument.uri)
		if (textDocument === undefined) {
			return codeActions;
		}
		let context : CodeActionContext = _params.context;
		let diagnostics : Diagnostic[] = context.diagnostics;

		codeActions = await getCodeActions(diagnostics, textDocument, _params);

		return codeActions;
	}
)

async function reverseENSLookup(address: string) : Promise<string> {
	if (ens === undefined) {
		return "";
	}

	let cached = ensReverseCache.get(address);
	if (cached !== undefined) {
		return cached;
	}
	let result = "";
	await ens.reverse(address).name().then(async function (name: string) {
		connection.console.log("Found ENS name for " + address + " is: " + name);
		// then forward ENS lookup to validate
		let addr = await ENSLookup(name);
		if (web3.utils.toChecksumAddress(address) == web3.utils.toChecksumAddress(addr)) {
			ensReverseCache.set(address, name);
			result = name;
		}
	}).catch(e => connection.console.log("Could not reverse lookup ENS name for " + address + " due to error: " + e));
	return result;
}

async function ENSLookup(name: string) : Promise<string> {
	if (ens === undefined) {
		return "";
	}

	let cached = ensCache.get(name);
	if (cached !== undefined) {
		return cached;
	}
	let result = "";
	await ens.resolver(name).addr().then(function (addr: string) {
		connection.console.log("ENS resolved address is " + addr);
		if (addr != "0x0000000000000000000000000000000000000000") {
			ensCache.set(name, addr);
			result = addr;
		}
	}).catch(e => connection.console.log("Could not do lookup ENS address for resolved name " + name + " due to error: " + e));
	return result;
}

async function getCodeActions(diagnostics: Diagnostic[], textDocument: TextDocument, params: CodeActionParams) : Promise<CodeAction[]> {
	let codeActions : CodeAction[] = [];

	// Get quick fixes for each diagnostic
	for (let i = 0; i < diagnostics.length; i++) {

		let diagnostic = diagnostics[i];
		if (String(diagnostic.code).startsWith(DIAGNOSTIC_TYPE_NOT_CHECKSUM_ADDRESS)) {
			let title : string = "Convert to checksum address";
			let range : Range = diagnostic.range;
			let replacement : string = String(diagnostic.code).substring(DIAGNOSTIC_TYPE_NOT_CHECKSUM_ADDRESS.length);
			codeActions.push(getQuickFix(diagnostic, title, range, replacement, textDocument));
		} else if (String(diagnostic.code).startsWith(DIAGNOSTIC_TYPE_CONVERT_TO_ENS_NAME)) {
			let replacement : string = String(diagnostic.code).substring(DIAGNOSTIC_TYPE_CONVERT_TO_ENS_NAME.length);
			let title : string = `Convert to ENS name \"${replacement}\"`;
			let range : Range = diagnostic.range;
			codeActions.push(getQuickFix(diagnostic, title, range, replacement, textDocument));
		} else if (String(diagnostic.code).startsWith(DIAGNOSTIC_TYPE_CONVERT_FROM_ENS_NAME)) {
			let replacement : string = String(diagnostic.code).substring(DIAGNOSTIC_TYPE_CONVERT_FROM_ENS_NAME.length);
			let title : string = `Convert to Ethereum address`;
			let range : Range = diagnostic.range;
			codeActions.push(getQuickFix(diagnostic, title, range, replacement, textDocument));
		} else if (String(diagnostic.code).startsWith(DIAGNOSTIC_TYPE_GENERATE_ABI)) {
			let address : string = String(diagnostic.code).substring(DIAGNOSTIC_TYPE_GENERATE_ABI.length);
			// generate ABI code action
			let abi : JSON | undefined = await getContractAbi(address);
			if (abi !== undefined) {
				let title : string = `Generate contract ABI`;
				let range : Range = diagnostic.range;
				codeActions.push(getRefactorExtract(diagnostic, title, range, abi, textDocument));
			}
		}
	}

	return codeActions;
}

function getQuickFix(diagnostic:Diagnostic, title:string, range:Range, replacement:string, textDocument:TextDocument) : CodeAction {
	let textEdit : TextEdit = { 
		range: range,
		newText: replacement
	};
	let workspaceEdit : WorkspaceEdit = {
		changes: { [textDocument.uri]:[textEdit] }
	}
	let codeAction : CodeAction = { 
		title: title, 
		kind: CodeActionKind.QuickFix,
		edit: workspaceEdit,
		diagnostics: [diagnostic]
	}
	return codeAction;
}

function getRefactorExtract(diagnostic:Diagnostic, title:string, range:Range, insert:JSON, textDocument:TextDocument) : CodeAction {
	range.start.line += 1;
	range.start.character = 0;
	range.end.line += 1;
	range.end.character = 0;
	let textEdit : TextEdit = { 
		range: range,
		newText: "\nconst CONTRACT_ABI = " + insert + "\n\n"
	};
	let workspaceEdit : WorkspaceEdit = {
		changes: { [textDocument.uri]:[textEdit] }
	}
	let codeAction : CodeAction = { 
		title: title, 
		kind: CodeActionKind.RefactorExtract,
		edit: workspaceEdit,
		diagnostics: [diagnostic]
	}
	return codeAction;
}

connection.onHover(

	async (_params: HoverParams): Promise<Hover> => {
		let textDocument = documents.get(_params.textDocument.uri)
		let position = _params.position
		let hover : Hover = {
			contents: ""
		}
		if (textDocument !== undefined) {
			var start = {
				line: position.line,
				character: 0,
			};
			var end = {
				line: position.line + 1,
				character: 0,
			};
			var text = textDocument.getText({ start, end });
			var index = textDocument.offsetAt(position) - textDocument.offsetAt(start);
			var word = getWord(text, index);

			let buf : MarkedString = "";
			if (isValidEthereumAddress(word)) {
				// Display Ethereum address, ENS name, mainnet ETH and DAI balances
				buf = await getHoverMarkdownForAddress(word);
			} else {
				let normalized = normalizeHex(word);
				if (isPrivateKey(normalized)) {
					// Convert to public key then display
					buf = await getHoverMarkdownForAddress(toPublicKey(normalized));
				} else {
					// If it's not a private key, check if it has an ENS name
					let address = await ENSLookup(word);
					if (address != "") {
						buf = await getHoverMarkdownForAddress(address);
					}
				}
			}
			hover.contents = buf;
		}
		return hover;
	}
	
);

async function getHoverMarkdownForAddress(address: string) {
	var result = await getMarkdownForTokenAddress(address)
	if (result === "") {
		result = await getMarkdownForRegularAddress(address)
	}
	return result;
}

async function getContractAbi(address: string) {
	let cached = abiCache.get(address);
	if (cached !== undefined && cached[0] > (Date.now() - cacheDurationSetting)) {
	 	return cached[1];
	}

	let abi : JSON | undefined = undefined;
	if (etherscanApiKeySetting !== "") {
		// Get token market data
		var options = {
			method: 'GET',
			url: 'https://api.etherscan.io/api?module=contract&action=getabi&address=' + address + '&apikey=' + etherscanApiKeySetting
		};

		await request(options, async function (error: string | undefined, response: any, body: any) {
			if (error) {
				connection.console.log("Request error while getting ABI for " + address + ": " + error);
				return;
			}
			var result = JSON.parse(body);
			if (result !== undefined && result.status !== undefined && result.status === "1" && result.result !== undefined) {
				abi = result.result;
				abiCache.set(address, [Date.now(), result.result]);
			}
		}).catch((error: string) => { connection.console.log("Error getting ABI for " + address + ": " + error) });
	}
	return abi;
}

async function getToken(address: string) {
	return (await getTopTokens()).get(address);
}

async function getMarkdownForTokenAddress(address: string) {
	let token : Token | undefined = await getToken(address);
	if (token !== undefined) {
		return getMarkdownForToken(token);
	}
	return "";
}

async function getMarkdownForRegularAddress(address: string) {
	let cached = addressMarkdownCache.get(address);
	if (cached !== undefined && cached[0] > (Date.now() - cacheDurationSetting)) { // cached timestamp not expired
		return cached[1]; // return cached markdown
	}

	let buf: string = "**Ethereum Address**: " + address + "\n\n";
	if (web3provider === undefined) {
		// no web3 provider, just show basic address and don't cache
		return buf;
	}

	// reverse ENS lookup
	let ensName: string = await reverseENSLookup(address);
	if (ensName != "") {
		buf += "**ENS Name**: " + ensName + "\n\n";
	}

	var web3connection = new Web3(web3provider);
	let balance = await web3connection.eth.getBalance(address);
	if (balance > BigNumber(0)) {
		buf += "**Ether Balance**:\n\n"
		    + "    " + web3.utils.fromWei(balance) + " ETH";
	}
	
	// Get ETH value and token balances using Amberdata.io APIs
	if (amberdataApiKeySetting !== "") {

		if (balance > BigNumber(0)) {
			// ETH value and price
			var options1 = {
				method: 'GET',
				url: 'https://web3api.io/api/v2/addresses/'+address+'/account-balances/latest',
				qs: {includePrice: 'true', currency: 'usd'},
				headers: {
				'x-amberdata-blockchain-id': 'ethereum-mainnet',
				'x-api-key': amberdataApiKeySetting
				}
			};

			await request(options1, async function (error: string | undefined, response: any, body: any) {
				if (error) {
					connection.console.log("Request error getting ETH balance: " + error);
					return;
				}
				var result = JSON.parse(body);
				if (result !== undefined && result.payload !== undefined && result.payload.price !== undefined && result.payload.value !== undefined) {
					var total = result.payload.price.value.total;
					var quote = result.payload.price.value.quote;
					buf += " (" + dollarFormat(total) + " USD @ " + dollarFormat(quote) + ")";
				}
			}).catch((error: string) => { connection.console.log("Error getting ETH balance: " + error) });

			buf += "\n\n";
		}

		// Token balances, values and price
		var options = {
			method: 'GET',
			url: 'https://web3api.io/api/v2/addresses/'+address+'/tokens',
			qs: {
			  direction: 'descending',
			  includePrice: 'true',
			  currency: 'usd',
			  sortType: 'amount',
			  page: '0',
			  size: '5'
			},
			headers: {
				'x-amberdata-blockchain-id': 'ethereum-mainnet',
				'x-api-key': amberdataApiKeySetting
			}
		};
	
		await request(options, async function (error: string | undefined, response: any, body: any) {
			if (error) {
				connection.console.log("Request error getting token balances: " + error);
				return;
			}
			var result = JSON.parse(body);
			if (result !== undefined && result.payload !== undefined && result.payload.records !== undefined && result.payload.records.length > 0) {
				buf += "**Tokens**:\n\n";
				result.payload.records.forEach((element: {
					symbol: any;
					amount: any;
					decimals: any;
					price: {
						amount: {
							quote: any;
							total: any;
						};
					};
				}) => {
					var symbol = element.symbol;
					var amount = BigNumber(element.amount).divide(BigNumber(10).power(BigNumber(element.decimals)));
					buf += "    " + numberFormat(amount, 0) + " " + symbol;
					if (element.price != null) {
						var quote = dollarFormat(element.price.amount.quote);
						var totalValue = dollarFormat(element.price.amount.total);
						buf += " (" + totalValue + " USD @ " + quote + ") \n";
					} else {
						buf += " \n";
					}
				});
			}
		}).catch((error: string) => { connection.console.log("Error getting token balances: " + error) });

	}
	addressMarkdownCache.set(address, [Date.now(), buf]);
	return buf;
}

function getWord(text: string, index: number) {
	var beginSubstring = text.substring(0, index);

	var endSubstring = text.substring(index, text.length);
	var boundaryRegex = /[^0-9a-zA-Z.]{1}/g; // boundaries are: not alphanumeric or dot
    var first = lastIndexOfRegex(beginSubstring, boundaryRegex) + 1;
	var last = index + indexOfRegex(endSubstring, boundaryRegex);

	return text.substring(first !== -1 ? first : 0, last !== -1 ? last : text.length - 1);
}

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
