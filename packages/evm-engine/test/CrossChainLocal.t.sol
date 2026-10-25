// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Vm, console2} from "forge-std/Test.sol";
import {ProductsBase} from "./Products.t.sol";
import {HomeGateway} from "../src/crosschain/HomeGateway.sol";
import {RemoteVault} from "../src/crosschain/RemoteVault.sol";
import {RemoteReceipt} from "../src/crosschain/RemoteReceipt.sol";
import {FreezableERC20} from "./mocks/MockERC20.sol";
import {CCIPLocalSimulator} from "@chainlink/local/src/ccip/CCIPLocalSimulator.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";

/// The auto-release end to end on Chainlink Local's CCIP router (CCIPLocalSimulator): the router delivers each
/// message at once with the exact gas limit the message asks for, as the CCIP off-ramp does, so the RELEASE gas
/// limit is exercised for real. One simulated chain carries both sides (Chainlink Local stamps every message with
/// its own source selector, which the vault and gateway are configured with).
/// A note with ETH collateral locked in the vault: (1) it defaults, and every holder's collateral is pushed out of
/// the engine, burned, queued, flushed by a CRE report and paid by the vault in the real token; (2) it is paid in
/// full, and the issuer's collateral comes back the same way on its withdraw.
contract CrossChainLocalTest is ProductsBase {
    uint64 constant SIM = 16015286601757825753; // the source selector Chainlink Local stamps on local messages

    CCIPLocalSimulator sim;
    IRouterClient router;
    HomeGateway gateway;
    RemoteVault vault;
    FreezableERC20 eth; // the collateral token on the asset chain
    RemoteReceipt rEth;

    function setUp() public override {
        super.setUp();
        sim = new CCIPLocalSimulator();
        (, router,,,,,) = sim.configuration();
        gateway = new HomeGateway(address(router), admin, address(engine), forwarder);
        vault = new RemoteVault(address(router), admin, SIM);
        eth = new FreezableERC20("ETH", decimals[2]);
        vm.startPrank(admin);
        vault.setHomeGateway(address(gateway));
        vault.setToken(address(eth), true);
        gateway.setRemote(SIM, address(vault), 300_000);
        rEth = RemoteReceipt(gateway.registerReceipt(SIM, address(eth), decimals[2], "ETH locked", "ETH.rh"));
        vm.stopPrank();
        gateway.fundFees{value: 1 ether}();
    }

    function _idx(string memory needle) internal view returns (uint256) {
        for (uint256 i = 0; i < fixtures.length; i++) {
            if (vm.indexOf(_fixture(i).name, needle) != type(uint256).max) return i;
        }
        revert("fixture not found");
    }

    /// ETH collateral (token 2) comes from the vault; everything else is local.
    function _tokens(Fixture memory f) internal view returns (address[] memory t) {
        t = new address[](f.tokenOf.length);
        for (uint256 a = 0; a < f.tokenOf.length; a++) {
            if (f.tokenOf[a] == 2) t[a] = address(rEth);
            else if (f.tokenOf[a] != 0) t[a] = address(tokens[f.tokenOf[a]]);
        }
    }

    function _lock(address who, uint256 base) internal {
        eth.mint(who, base);
        vm.startPrank(who);
        eth.approve(address(vault), base);
        vault.lock(address(eth), base, who); // Chainlink Local delivers LOCKED in the same call: receipts minted
        vm.stopPrank();
    }

    function _run(uint256 idx) internal returns (Fixture memory f, uint256 pid, address issuer, address[] memory holders, uint8 a) {
        f = _fixture(idx);
        issuer = makeAddr(string.concat("issuer", vm.toString(idx)));
        vm.warp(t0);
        bytes32 id = engine.registerDefinition(f.def);
        vm.prank(issuer);
        pid = engine.startProcess(id, 1, _roles(issuer, makeAddr("pa")), _tokens(f), f.startStep, _none(), "Note", "NOTE");
        vm.startPrank(issuer);
        for (uint256 t = 1; t < 5; t++) tokens[t].approve(address(engine), type(uint256).max);
        rEth.approve(address(engine), type(uint256).max);
        vm.stopPrank();
        for (uint256 k = 0; k < f.pledges.length; k++) {
            if (f.pledges[k].token == 2) _lock(issuer, f.pledges[k].base);
            else tokens[f.pledges[k].token].mint(issuer, f.pledges[k].base);
        }
        assertEq(rEth.balanceOf(issuer), vault.locked(address(eth)), "receipts minted for the lock");
        vm.startPrank(issuer);
        engine.executeStep(pid, f.approveStep, NO, f.approveInputs);
        engine.executeStep(pid, f.mandateStep, NO, _none());
        vm.stopPrank();
        holders = _holders(f, idx);
        for (uint256 k = 0; k < f.investorUnits.length; k++) _subscribe(f, pid, holders[k], f.investorUnits[k], f.investorCash[k]);
        for (uint256 i = 0; i < f.actions.length; i++) {
            Action memory x = f.actions[i];
            if (x.at > block.timestamp) vm.warp(x.at);
            if (x.kind == 1) _report(pid, x.step, x.values);
            else if (x.kind == 2) _report(pid, NO, new int256[](0));
            else if (x.kind == 3) {
                if (x.token == 2) _lock(issuer, x.base);
                else tokens[x.token].mint(issuer, x.base);
                vm.prank(issuer);
                engine.executeStep(pid, x.step, NO, x.inputs);
            } else revert("no secondary transfer here");
        }
        assertEq(engine.processOf(pid).status, engine.COMPLETED(), "completed");
        for (uint8 y = CASH + 1; y < f.tokenOf.length; y++) if (f.tokenOf[y] == 2) a = y;
        assertGt(a, 0, "ETH collateral");
    }

    function test_local_default_pushedToHolders_creFlush_paidInTheRealToken() public {
        (Fixture memory f, uint256 pid,, address[] memory holders, uint8 a) = _run(_idx("margin call not cured"));
        assertTrue(f.defaulted);
        uint256 dec = rEth.decimals();
        uint256[] memory owed = new uint256[](holders.length);
        for (uint256 k = 0; k < holders.length; k++) {
            owed[k] = uint256(engine.balanceOf(pid, holders[k], a) * int256(10 ** dec) / SCALE);
            assertApproxEqAbs(engine.balanceOf(pid, holders[k], a), f.expected[k][a], uint256(TOLERANCE), "reference payout");
        }
        vm.prank(keeper);
        uint256 g = gasleft();
        engine.pushTo(pid, a, holders);
        console2.log("pushTo of the collateral to", holders.length, "holders, releases queued (gas):", g - gasleft());
        for (uint256 k = 0; k < holders.length; k++) assertEq(rEth.balanceOf(holders[k]), 0, "never in the wallet");
        uint256 queued = gateway.releasesQueued();
        assertGt(queued, 0);
        vm.prank(forwarder);
        g = gasleft();
        gateway.onReport("", abi.encode(uint8(1), uint256(25))); // CRE: flush; Chainlink Local runs each RELEASE
        console2.log("CRE flush report, releases sent and executed by Chainlink Local (gas):", g - gasleft());
        for (uint256 k = 0; k < holders.length; k++) {
            assertApproxEqAbs(eth.balanceOf(holders[k]), owed[k], 1, "the vault paid the holder in the real token");
        }
        assertEq(gateway.releasesSent(), queued);
        assertEq(vault.locked(address(eth)), rEth.totalSupply(), "locked = receipts outstanding");
    }

    function test_local_paidInFull_issuerCollateralReleasedOnWithdraw() public {
        (Fixture memory f, uint256 pid, address issuer,, uint8 a) = _run(_idx("margin call cured"));
        assertFalse(f.defaulted);
        int256 back = engine.balanceOf(pid, issuer, a);
        assertApproxEqAbs(back, f.issuerCollateral[a], uint256(TOLERANCE), "collateral back to the issuer");
        uint256 base = uint256(back * int256(10 ** rEth.decimals()) / SCALE);
        vm.prank(issuer);
        engine.withdraw(pid, a, base);
        assertEq(rEth.balanceOf(issuer), 0, "burned on the way out");
        vm.prank(makeAddr("anyone"));
        gateway.flush(25);
        assertEq(eth.balanceOf(issuer), base, "the issuer has its real collateral back on the asset chain");
        assertEq(rEth.totalSupply(), vault.locked(address(eth)));
    }
}
