import { generateWallet } from "@stacks/wallet-sdk";
import { privateKeyToAddress } from "@stacks/transactions";

/**
 * Resolve STACKS_PRIVATE_KEY into a signing key.
 *
 * Wallets like Leather and Xverse hand users a 24-word seed phrase, not a raw
 * private key, so both are accepted and the phrase is derived locally. Nothing
 * is transmitted: derivation is pure computation in this process, and the
 * resulting key is used only to sign a transaction the user has confirmed.
 *
 * A seed phrase controls every account the wallet can derive, so it belongs
 * only to a wallet created for this purpose — never a wallet holding funds the
 * user cares about.
 */
export interface ResolvedSigner {
  privateKey: string;
  address: string;
  /** how the credential was supplied, for display */
  source: "private key" | "seed phrase";
}

const HEX_KEY = /^[0-9a-fA-F]{64}(01)?$/;

export async function resolveSigner(raw: string | undefined): Promise<ResolvedSigner> {
  const value = (raw ?? "").trim();
  if (!value) {
    throw new Error(
      "STACKS_PRIVATE_KEY is not set.\n" +
        "Put it in .env (or export it) as either a 64-character hex private key\n" +
        "or a 12/24-word seed phrase. Use a wallet created only for this test.",
    );
  }

  const words = value.split(/\s+/).filter(Boolean);
  if (words.length >= 12) {
    if (words.length !== 12 && words.length !== 24) {
      throw new Error(
        `STACKS_PRIVATE_KEY looks like a seed phrase but has ${words.length} words; expected 12 or 24.`,
      );
    }
    const wallet = await generateWallet({ secretKey: words.join(" "), password: "" });
    const account = wallet.accounts[0];
    if (!account) throw new Error("Could not derive an account from that seed phrase.");
    const privateKey = account.stxPrivateKey;
    return { privateKey, address: privateKeyToAddress(privateKey, "mainnet"), source: "seed phrase" };
  }

  if (!HEX_KEY.test(value)) {
    throw new Error(
      `STACKS_PRIVATE_KEY is not a recognised format (${value.length} characters).\n` +
        "Expected a 64-character hex private key, or a 12/24-word seed phrase.",
    );
  }

  return { privateKey: value, address: privateKeyToAddress(value, "mainnet"), source: "private key" };
}
