/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
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
	WorkspaceEdit
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

const NAME: string = 'DeFi Language Support';

const DIAGNOSTIC_TYPE_NOT_VALID_ADDRESS: string = 'NotValidAddress';
const DIAGNOSTIC_TYPE_NOT_CHECKSUM_ADDRESS: string = 'NotChecksumAddress';

const CODE_LENS_TYPE_ETH_ADDRESS: string = 'EthAddress';
const CODE_LENS_TYPE_ETH_PRIVATE_KEY: string = 'EthPrivateKey';

const MAINNET: string = 'mainnet';
const ROPSTEN: string = 'ropsten';
const KOVAN: string = 'kovan';
const RINKEBY: string = 'rinkeby';
const GOERLI: string = 'goerli';
const NETWORKS : string[] = [ MAINNET, ROPSTEN, KOVAN, RINKEBY, GOERLI];

var Web3 = require('web3');
var web3 = new Web3();
var ENS = require('ethereum-ens');
var Wallet = require('ethereumjs-wallet')
var EthUtil = require('ethereumjs-util')

// to be defined at runtime
var web3provider;
var ens: { 
	resolver: (arg0: string) => { (): any; new(): any; addr: { (): Promise<any>; new(): any; }; };
	 reverse: (arg0: string) => { (): any; new(): any; name: { (): Promise<any>; new(): any; }; };  
};

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
			textDocumentSync: TextDocumentSyncKind.Full,
			// Tell the client that the server supports code completion
			completionProvider: {
				resolveProvider: true
			},
			codeLensProvider : {
				resolveProvider: true
			},
			codeActionProvider : {
				codeActionKinds : [ CodeActionKind.QuickFix ]
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
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: DefiSettings = { maxNumberOfProblems: 1000, infuraProjectId: "", infuraProjectSecret: "" };
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
		connection.console.error("Infura project ID and/or secret has not been set. Obtain them from https://infura.io/ and set the in the VS Code settings by searching for \"Infura\".");
	} else {
		// set up infura and ENS
		web3provider = new Web3.providers.HttpProvider('https://:' + settings.infuraProjectSecret + '@mainnet.infura.io/v3/' + settings.infuraProjectId);
		ens = new ENS(web3provider);
	}

	let diagnostics: Diagnostic[] = [];

	let possibleEthereumAddresses : StringLocation[] = findPossibleEthereumAddresses(textDocument);
	let problems = 0;
	possibleEthereumAddresses.forEach( (element) => {
		if (problems < settings.maxNumberOfProblems) {
			problems++;
			if (!isValidEthereumAddress(element.content)) {
				// Invalid checksum
				addDiagnostic(element, `${element.content} is not a valid Ethereum address`, 'The string appears to be an Ethereum address but fails checksum.', DiagnosticSeverity.Error, DIAGNOSTIC_TYPE_NOT_VALID_ADDRESS);
			} else {
				// Not a checksum address
				var checksumAddress = web3.utils.toChecksumAddress(element.content);
				if (element.content != checksumAddress) {
					addDiagnostic(element, `${element.content} is not a checksum address`, 'Use a checksum address as a best practice to ensure the address is valid.', DiagnosticSeverity.Warning, DIAGNOSTIC_TYPE_NOT_CHECKSUM_ADDRESS);
				}
			}
		}
	});

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

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('We received an file change event');
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
	(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
		// The pass parameter contains the position of the text document in
		// which code complete got requested. For the example we ignore this
		// info and always provide the same completion items.
		return [
			{
				label: 'TypeScript',
				kind: CompletionItemKind.Text,
				data: 1
			},
			{
				label: 'JavaScript',
				kind: CompletionItemKind.Text,
				data: 2
			}
		];
	}
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		if (item.data === 1) {
			item.detail = 'TypeScript details';
			item.documentation = 'TypeScript documentation';
		} else if (item.data === 2) {
			item.detail = 'JavaScript details';
			item.documentation = 'JavaScript documentation';
		}
		return item;
	}
);

export interface StringLocation {
    range: Range;
    content: string;
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
			content: "0x" + m[0] // 0x prepended private key
		};
		locations.push(location);
	}
	return locations;
}

function isPrivateKey(possiblePrivateKey: string) {
	try {
		connection.console.log(`string is ` + possiblePrivateKey);
		var privateKeyBuffer = EthUtil.toBuffer(possiblePrivateKey)
		Wallet.fromPrivateKey(privateKeyBuffer)
		//new ethers.Wallet(possiblePrivateKey)
	} catch(e) {
		connection.console.log("return false");
		connection.console.log(e);
		return false;
	}
	connection.console.log("return true");
	return true;
}

function toPublicKey(privateKey: string) : string {
	return web3.eth.accounts.privateKeyToAccount(privateKey).address;
}

// Handle code lens requests
connection.onCodeLens(
	(_params: CodeLensParams): CodeLens[] => {
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
			let ensName : string = "";
			// reverse ENS lookup
			await ens.reverse(address).name().then(async function(name: string) { 
				connection.console.log("Found ENS name for " + address + " is: " + name); 
				// then forward ENS lookup to validate
				await ens.resolver(name).addr().then(function(addr: string) { 
					connection.console.log("Original address is " + address); 
					connection.console.log("ENS resolved address is " + addr);
					if (web3.utils.toChecksumAddress(address) == web3.utils.toChecksumAddress(addr)) {
						connection.console.log("The names match!"); 
						ensName = name;
					}
				}).catch(e =>
					connection.console.log("Could not do lookup ENS address for resolved name " + name + " due to error: " + e)
				);
			}).catch(e =>
				connection.console.log("Could not reverse lookup ENS name for " + address + " due to error: " + e)
			);
			
			let prefix = "";
			if (ensName != "") {
				prefix = ensName + " | "
			}
			if (codeLensType === CODE_LENS_TYPE_ETH_ADDRESS) {
				codeLens.command = Command.create(prefix + "Ethereum address (mainnet): " + address, "etherscan.show.url", "https://etherscan.io/address/" + address);
			} else if (codeLensType === CODE_LENS_TYPE_ETH_PRIVATE_KEY) {
				codeLens.command = Command.create(prefix + "Private key with Ethereum address (mainnet): " + address, "etherscan.show.url", "https://etherscan.io/address/" + address);
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

connection.onCodeAction(
	(_params: CodeActionParams): CodeAction[] => {
		let codeActions : CodeAction[] = [];

		let textDocument = documents.get(_params.textDocument.uri)
		if (textDocument === undefined) {
			return codeActions;
		}
		let context : CodeActionContext = _params.context;
		let diagnostics : Diagnostic[] = context.diagnostics;

		codeActions = getQuickFixes(diagnostics, textDocument, _params);

		return codeActions;
	}
)

function getQuickFixes(diagnostics: Diagnostic[], textDocument: TextDocument, params: CodeActionParams) : CodeAction[] {
	let codeActions : CodeAction[] = [];
	diagnostics.forEach( (diagnostic) => {
		if (diagnostic.code === DIAGNOSTIC_TYPE_NOT_CHECKSUM_ADDRESS) {
			let title : string = "Convert to checksum address";
			let range : Range = diagnostic.range;
			let replacement : string = web3.utils.toChecksumAddress(textDocument.getText(range));
			codeActions.push(getQuickFix(diagnostic, title, range, replacement, textDocument));
		}
	});
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

/*
connection.onDidOpenTextDocument((params) => {
	// A text document got opened in VSCode.
	// params.textDocument.uri uniquely identifies the document. For documents store on disk this is a file URI.
	// params.textDocument.text the initial full content of the document.
	connection.console.log(`${params.textDocument.uri} opened.`);
});
connection.onDidChangeTextDocument((params) => {
	// The content of a text document did change in VSCode.
	// params.textDocument.uri uniquely identifies the document.
	// params.contentChanges describe the content changes to the document.
	connection.console.log(`${params.textDocument.uri} changed: ${JSON.stringify(params.contentChanges)}`);
});
connection.onDidCloseTextDocument((params) => {
	// A text document got closed in VSCode.
	// params.textDocument.uri uniquely identifies the document.
	connection.console.log(`${params.textDocument.uri} closed.`);
});
*/

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
