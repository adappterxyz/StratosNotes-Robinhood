import { describe, expect, it } from 'vitest';
import { ContractFunctionExecutionError, ContractFunctionRevertedError, parseAbi, encodeErrorResult } from 'viem';
import { errText } from './format';

const abi = parseAbi(['function registerDefinition(bytes data)', 'error IssuerEmailNotVerified(address issuer)']);
const wrap = (cause: Error) =>
  new ContractFunctionExecutionError(cause as never, {
    abi,
    functionName: 'registerDefinition',
    args: ['0x'],
    contractAddress: '0x7d36Da43724b09Bb03ED98a4574685070073020b',
  });

describe('errText', () => {
  it('shows a revert reason string instead of a dangling "reason:"', () => {
    const data = encodeErrorResult({
      abi: parseAbi(['error Error(string)']),
      errorName: 'Error',
      args: ['too many steps'],
    });
    const t = errText(wrap(new ContractFunctionRevertedError({ abi, data, functionName: 'registerDefinition' })));
    expect(t).toContain('too many steps');
    expect(t).not.toMatch(/reason:\s*$/);
  });
  it('names a custom engine error in plain words', () => {
    const data = encodeErrorResult({
      abi,
      errorName: 'IssuerEmailNotVerified',
      args: ['0x298afB9424188C7eA7c01556D8CAE6ff4768de0a'],
    });
    expect(
      errText(wrap(new ContractFunctionRevertedError({ abi, data, functionName: 'registerDefinition' }))),
    ).toContain('verify your email before issuing');
  });
  it('keeps the wallet rejection message', () => {
    expect(errText(new Error('User rejected the request.\nDetails: ...'))).toBe(
      'You rejected the request in your wallet.',
    );
  });
});
