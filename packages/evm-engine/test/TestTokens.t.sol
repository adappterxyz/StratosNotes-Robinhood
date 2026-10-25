// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TestToken} from "../src/test-tokens/TestToken.sol";
import {TokenFaucet} from "../src/test-tokens/TokenFaucet.sol";

contract TestTokensTest is Test {
    TestToken usd;
    TokenFaucet faucet;
    address alice = address(0xA11CE);

    function setUp() public {
        faucet = new TokenFaucet(address(this));
        usd = new TestToken("Test USD", "tUSD", 6, address(this));
        usd.setMinter(address(faucet), true);
        faucet.setDrip(address(usd), 2_000e6, 1 hours);
    }

    function test_claimPaysTheDrip() public {
        vm.prank(alice);
        faucet.claim(address(usd));
        assertEq(usd.balanceOf(alice), 2_000e6);
    }

    function test_secondClaimWaitsForTheCooldown() public {
        vm.prank(alice);
        faucet.claim(address(usd));
        assertEq(faucet.nextClaimAt(address(usd), alice), block.timestamp + 1 hours);
        vm.prank(alice);
        vm.expectRevert();
        faucet.claim(address(usd));
    }

    function test_claimAgainAfterTheCooldown() public {
        vm.prank(alice);
        faucet.claim(address(usd));
        skip(1 hours);
        vm.prank(alice);
        faucet.claim(address(usd));
        assertEq(usd.balanceOf(alice), 4_000e6);
    }

    function test_onlyMintersMint() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TestToken.NotMinter.selector, alice));
        usd.mint(alice, 1);
        usd.mint(alice, 5); // the owner may mint for demo setup
        assertEq(usd.balanceOf(alice), 5);
    }

    function test_unlistedTokenRefused() public {
        vm.expectRevert(abi.encodeWithSelector(TokenFaucet.NotListed.selector, address(0xBEEF)));
        faucet.claim(address(0xBEEF));
    }

    function test_onlyOwnerConfigures() public {
        vm.prank(alice);
        vm.expectRevert();
        faucet.setDrip(address(usd), 1, 1);
        vm.prank(alice);
        vm.expectRevert();
        usd.setMinter(alice, true);
    }
}
