import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import solc from 'solc';

const sources = Object.fromEntries(['contracts/Tranche.sol', 'contracts/test/Mocks.sol'].map(file => [
  file, { content: readFileSync(file, 'utf8') },
]));
const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input), {
  import(path) {
    try {
      return { contents: readFileSync(resolve('node_modules', path), 'utf8') };
    } catch {
      return { error: `Cannot read dependency ${path}` };
    }
  },
}));
for (const issue of output.errors ?? []) process.stderr.write(issue.formattedMessage);
if ((output.errors ?? []).some(issue => issue.severity === 'error')) process.exit(1);

mkdirSync('src/generated', { recursive: true });
mkdirSync('test/generated', { recursive: true });
for (const [file, name, destination] of [
  ['contracts/Tranche.sol', 'Tranche', 'src/generated'],
  ['contracts/test/Mocks.sol', 'MockToken', 'test/generated'],
  ['contracts/test/Mocks.sol', 'MockRouter', 'test/generated'],
]) {
  const contract = output.contracts[file][name];
  writeFileSync(`${destination}/${name}.json`, JSON.stringify({
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`,
  }, null, 2) + '\n');
}
