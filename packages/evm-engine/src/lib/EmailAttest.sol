// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title EmailAttest - verified-email attestations, bound on-chain as a salted hash
/// @notice A separate, linked library (like DefCheck: its code is not part of FlowEngine's 24 KiB). The API
///         verifies a person's email (a 6-digit code sent to it), picks a random 32-byte salt and signs, with the
///         engine's `verifier` key, an EIP-712 `EmailAttestation(holder, emailHash, expiry, nonce)` where
///         emailHash = keccak256(abi.encode(salt, lowercase(trimmed email))). Anyone may submit it (usually the
///         person, from the app). The chain never sees the email or the salt; the person can download the salt to
///         prove later which email they bound. `nonce` (per holder, bumped by every attestation and revocation)
///         makes an old attestation unusable once a newer one or a revocation has landed.
library EmailAttest {
    struct Email {
        bytes32 hash;
        uint64 verifiedUntil;
        uint64 nonce;
    }

    bytes32 internal constant TYPEHASH = keccak256("EmailAttestation(address holder,bytes32 emailHash,uint64 expiry,uint256 nonce)");
    bytes32 internal constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    event EmailAttested(address indexed holder, bytes32 emailHash, uint64 expiry);
    event EmailRevoked(address indexed holder);

    error AttestationExpired();
    error AttestationInvalid();
    error NotVerifier();

    /// The EIP-712 digest the verifier signs (called from FlowEngine, so `address(this)` is the engine).
    function digest(address holder, bytes32 emailHash, uint64 expiry, uint256 nonce) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("notes.markets"), keccak256("1"), block.chainid, address(this)));
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(TYPEHASH, holder, emailHash, expiry, nonce))));
    }

    function attest(
        mapping(address => Email) storage emails,
        address verifier,
        address holder,
        bytes32 emailHash,
        uint64 expiry,
        bytes calldata sig
    ) external {
        if (expiry <= block.timestamp) revert AttestationExpired();
        Email storage e = emails[holder];
        if (holder == address(0) || emailHash == bytes32(0) || verifier == address(0)) revert AttestationInvalid();
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest(holder, emailHash, expiry, e.nonce), sig);
        if (err != ECDSA.RecoverError.NoError || signer != verifier) revert AttestationInvalid();
        e.hash = emailHash;
        e.verifiedUntil = expiry;
        e.nonce += 1;
        emit EmailAttested(holder, emailHash, expiry);
    }

    function revoke(mapping(address => Email) storage emails, address verifier, address owner, address holder) external {
        if (msg.sender != verifier && msg.sender != owner) revert NotVerifier();
        Email storage e = emails[holder];
        e.hash = bytes32(0);
        e.verifiedUntil = 0;
        e.nonce += 1;
        emit EmailRevoked(holder);
    }
}
