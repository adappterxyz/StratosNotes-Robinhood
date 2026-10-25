#!/usr/bin/env python3
"""Record where a deployment's events start, in the chain's own block numbers.

On Arbitrum chains Solidity's block.number is the L1 (Ethereum) block, so the `block` that Deploy.s.sol writes
is not a block of the chain itself; event scans (the indexer's start block, the SDK's history) need the chain's
own number. The deploy scripts read the chain's head just before deploying and pass it here:

    python3 scripts/set-deploy-block.py <deployment.json> <block>
"""
import json, sys

path, block = sys.argv[1], int(sys.argv[2])
d = json.load(open(path))
d['l1Block'] = d.get('block')
d['block'] = block
json.dump(d, open(path, 'w'), indent=2)
open(path, 'a').write('\n')
