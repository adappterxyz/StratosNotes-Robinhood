/**
 * API configuration (a JSON file, with secrets from the environment only).
 *
 * {
 *   "allowedOrigins": ["https://notes.markets"],
 *   "trustProxy": true,                       // take the client IP from X-Forwarded-For (behind a load balancer)
 *   "chains": [{ "key": "arbitrum-sepolia", "rpc": "https://…", "engine": "0x…", "lens": "0x…", "fromBlock": 123,
 *                "stablecoin": { "symbol": "USDC", "address": "0x…", "decimals": 6 },
 *                "faucet": { "token": "0x…", "amount": "2000" } }],     // dev chains only: mints a MockERC20
 *   "ai": true                                 // needs CF_ACCOUNT_ID and CF_AI_TOKEN in the environment
 * }
 */
import { z } from 'zod';

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

/** Cross-chain collateral (docs/CROSS-CHAIN.md), passed to the app as is. */
const CrossChainCfg = z.object({
  role: z.enum(['home', 'asset']),
  router: addr,
  selector: z.string().regex(/^\d+$/),
  gateway: addr.optional(),
  vault: addr.optional(),
  home: z.object({ chain: z.string(), gateway: addr, selector: z.string() }).optional(),
  remotes: z
    .array(
      z.object({
        chain: z.string(),
        selector: z.string(),
        vault: addr,
        receipts: z.record(
          z.object({
            receipt: addr,
            token: addr,
            decimals: z.number().int(),
            valuedAs: z.string().nullable(),
            note: z.string().optional(),
          }),
        ),
      }),
    )
    .optional(),
});

/**
 * An earlier engine on the chain whose notes stay on it (FlowEngine v3 next to v4; docs/ERC20-NOTES.md §8). The
 * app reads and acts on those notes with this engine's address, lens and ABI version; new issuance goes to the
 * chain's current engine. `tokens` are the symbols that differ for its notes (its cross-chain receipts), and
 * `crossChain` its own gateway–vault pair, through which its collateral is still released.
 */
export const LegacyEngineCfg = z.object({
  engine: addr,
  lens: addr,
  fromBlock: z.number().int().nonnegative().default(0),
  version: z.number().int().positive(),
  tokens: z.record(addr).default({}),
  crossChain: CrossChainCfg.optional(),
});
export type LegacyEngineCfg = z.infer<typeof LegacyEngineCfg>;

export const ChainCfg = z.object({
  key: z.string().regex(/^[a-z0-9-]{1,40}$/),
  /** The RPC the app's wallet and reads use (public). */
  rpc: z.string().url(),
  engine: addr,
  lens: addr,
  fromBlock: z.number().int().nonnegative().default(0),
  stablecoin: z.object({ symbol: z.string(), address: addr, decimals: z.number().int().min(0).max(36) }),
  /** Dev chains only: the API mints this MockERC20 to callers (the key comes from FAUCET_KEY). */
  faucet: z.object({ token: addr, amount: z.string().regex(/^\d+$/) }).optional(),
  /** The retired notes.markets TokenFaucet (optional; scripts/server-config.ts no longer writes it). `tokens`: the
   * chain's real tokens by symbol (USDG, WETH, Robinhood's stock tokens), receipts on the home chain, and tUSD where
   * older notes settle in it. */
  tokenFaucet: addr.optional(),
  tokens: z.record(addr).default({}),
  /**
   * Cross-chain collateral (docs/CROSS-CHAIN.md), passed to the app as is: on the home chain the gateway and each
   * asset chain's vault and receipts; on an asset chain its vault and the home gateway.
   */
  crossChain: CrossChainCfg.optional(),
  /** Earlier engines on this chain, oldest first. */
  legacyEngines: z.array(LegacyEngineCfg).default([]),
  /** Earlier gateway–vault pairs of the CURRENT engine (replaced by a newer pair): receipts still held in wallets
   * redeem through their own gateway. */
  previousCrossChain: z.array(CrossChainCfg).default([]),
});
export type ChainCfg = z.infer<typeof ChainCfg>;

export const ApiConfig = z.object({
  allowedOrigins: z.array(z.string().url()).default([]),
  trustProxy: z.boolean().default(false),
  chains: z.array(ChainCfg),
  ai: z.boolean().default(false),
  limits: z
    .object({
      readsPerMinute: z.number().default(600),
      aiPerHour: z.number().default(60),
      templatesPerHour: z.number().default(20),
      faucetPerHour: z.number().default(6),
      streamsPerIp: z.number().default(10),
    })
    .default({}),
});
export type ApiConfig = z.infer<typeof ApiConfig>;
