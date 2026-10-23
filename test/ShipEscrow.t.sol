// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {ShipEscrow} from "../src/ShipEscrow.sol";

contract MockToken is ERC20 {
    constructor() ERC20("World is Flat", "WIF") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Takes 1% of every transfer, to check the escrow credits what actually arrived.
contract FeeToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xFEE), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

contract ShipEscrowTest is Test {
    ShipEscrow escrow;
    MockToken wif;
    uint256 attesterKey = 0xA11CE;
    address attester;
    address builder = address(0xB0B);
    address alice = address(0xA1);
    address carol = address(0xCA);
    string constant SLUG = "my-wif-tool";

    function setUp() public {
        vm.warp(1_800_000_000);
        attester = vm.addr(attesterKey);
        escrow = new ShipEscrow(attester);
        wif = new MockToken();
        wif.mint(alice, 1_000_000 ether);
        wif.mint(carol, 1_000_000 ether);
        vm.prank(alice);
        wif.approve(address(escrow), type(uint256).max);
        vm.prank(carol);
        wif.approve(address(escrow), type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers

    function _open(uint256 amount, uint32 minShips, uint16 burnBps) internal returns (uint256 id) {
        vm.prank(alice);
        id = escrow.create(address(wif), builder, SLUG, minShips, uint64(block.timestamp + 14 days), burnBps, amount);
    }

    function _att(uint256 id, uint32 ships) internal view returns (ShipEscrow.Ships memory a) {
        ShipEscrow.Bounty memory b = escrow.bounty(id);
        a = ShipEscrow.Ships({
            project: keccak256(bytes(SLUG)),
            since: b.start,
            until: uint64(block.timestamp),
            ships: ships,
            evidence: keccak256("ship:1,ship:2"),
            issuedAt: uint64(block.timestamp)
        });
    }

    function _sign(ShipEscrow.Ships memory a, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, escrow.digest(a));
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------------ create / fund

    function test_createAndFund() public {
        uint256 id = _open(100 ether, 2, 0);
        vm.prank(carol);
        escrow.fund(id, 50 ether);
        ShipEscrow.Bounty memory b = escrow.bounty(id);
        assertEq(b.total, 150 ether);
        assertEq(b.project, keccak256(bytes(SLUG)));
        assertEq(escrow.contributed(id, alice), 100 ether);
        assertEq(escrow.contributed(id, carol), 50 ether);
        assertEq(wif.balanceOf(address(escrow)), 150 ether);
        assertEq(escrow.bountyCount(), 1);
        assertEq(escrow.slugOf(id), SLUG);
    }

    function test_createRejectsBadInput() public {
        vm.startPrank(alice);
        uint64 dl = uint64(block.timestamp + 14 days);
        vm.expectRevert(ShipEscrow.ZeroAddress.selector);
        escrow.create(address(wif), address(0), SLUG, 1, dl, 0, 0);
        vm.expectRevert(ShipEscrow.NotAToken.selector);
        escrow.create(address(0x1234), builder, SLUG, 1, dl, 0, 0);
        vm.expectRevert(ShipEscrow.BadSlug.selector);
        escrow.create(address(wif), builder, "", 1, dl, 0, 0);
        vm.expectRevert(ShipEscrow.BadMinShips.selector);
        escrow.create(address(wif), builder, SLUG, 0, dl, 0, 0);
        vm.expectRevert(ShipEscrow.BadDeadline.selector);
        escrow.create(address(wif), builder, SLUG, 1, uint64(block.timestamp + 1 hours), 0, 0);
        vm.expectRevert(ShipEscrow.BadDeadline.selector);
        escrow.create(address(wif), builder, SLUG, 1, uint64(block.timestamp + 400 days), 0, 0);
        vm.expectRevert(ShipEscrow.BurnTooHigh.selector);
        escrow.create(address(wif), builder, SLUG, 1, dl, 1_001, 0);
        vm.stopPrank();
    }

    function test_fundClosesAtDeadline() public {
        uint256 id = _open(1 ether, 1, 0);
        vm.warp(block.timestamp + 14 days);
        vm.prank(carol);
        vm.expectRevert(ShipEscrow.FundingClosed.selector);
        escrow.fund(id, 1 ether);
    }

    function test_unknownBounty() public {
        vm.expectRevert(ShipEscrow.UnknownBounty.selector);
        escrow.bounty(0);
    }

    // ------------------------------------------------------------------ claim

    function test_claimPaysBuilderAndBurns() public {
        uint256 id = _open(1_000 ether, 2, 200); // 2% burned
        vm.warp(block.timestamp + 3 days);
        ShipEscrow.Ships memory a = _att(id, 3);
        vm.prank(carol); // anyone can submit
        escrow.claim(id, a, _sign(a, attesterKey));
        assertEq(wif.balanceOf(builder), 980 ether);
        assertEq(wif.balanceOf(escrow.BURN_ADDRESS()), 20 ether);
        assertEq(wif.balanceOf(address(escrow)), 0);
        assertTrue(escrow.bounty(id).paid);
    }

    function test_claimTwiceReverts() public {
        uint256 id = _open(10 ether, 1, 0);
        vm.warp(block.timestamp + 1 days);
        ShipEscrow.Ships memory a = _att(id, 1);
        bytes memory sig = _sign(a, attesterKey);
        escrow.claim(id, a, sig);
        vm.expectRevert(ShipEscrow.AlreadyPaid.selector);
        escrow.claim(id, a, sig);
    }

    function test_claimRejectsWrongSigner() public {
        uint256 id = _open(10 ether, 1, 0);
        vm.warp(block.timestamp + 1 days);
        ShipEscrow.Ships memory a = _att(id, 5);
        bytes memory sig = _sign(a, 0xBAD);
        vm.expectRevert(ShipEscrow.BadSignature.selector);
        escrow.claim(id, a, sig);
    }

    function test_claimRejectsTamperedCount() public {
        uint256 id = _open(10 ether, 3, 0);
        vm.warp(block.timestamp + 1 days);
        ShipEscrow.Ships memory a = _att(id, 1);
        bytes memory sig = _sign(a, attesterKey);
        a.ships = 3; // signed 1, claims 3
        vm.expectRevert(ShipEscrow.BadSignature.selector);
        escrow.claim(id, a, sig);
    }

    function test_claimRejectsTooFewShips() public {
        uint256 id = _open(10 ether, 3, 0);
        vm.warp(block.timestamp + 1 days);
        ShipEscrow.Ships memory a = _att(id, 2);
        bytes memory sig = _sign(a, attesterKey);
        vm.expectRevert(ShipEscrow.NotEnoughShips.selector);
        escrow.claim(id, a, sig);
    }

    function test_claimRejectsOtherProject() public {
        uint256 id = _open(10 ether, 1, 0);
        vm.warp(block.timestamp + 1 days);
        ShipEscrow.Ships memory a = _att(id, 4);
        a.project = keccak256("someone-else");
        bytes memory sig = _sign(a, attesterKey);
        vm.expectRevert(ShipEscrow.WrongProject.selector);
        escrow.claim(id, a, sig);
    }

    function test_claimRejectsWindowBeforeBountyOpened() public {
        uint256 id = _open(10 ether, 1, 0);
        vm.warp(block.timestamp + 1 days);
        ShipEscrow.Ships memory a = _att(id, 4);
        a.since = a.since - 30 days; // ships from before the bounty
        bytes memory sig = _sign(a, attesterKey);
        vm.expectRevert(ShipEscrow.WrongWindow.selector);
        escrow.claim(id, a, sig);
    }

    function test_claimRejectsShipsAfterDeadline() public {
        uint256 id = _open(10 ether, 1, 0);
        vm.warp(block.timestamp + 15 days); // past the deadline, inside the grace
        ShipEscrow.Ships memory a = _att(id, 4); // until = now > deadline
        bytes memory sig = _sign(a, attesterKey);
        vm.expectRevert(ShipEscrow.WrongWindow.selector);
        escrow.claim(id, a, sig);
    }

    function test_claimInGraceWithWindowEndingAtDeadline() public {
        uint256 id = _open(10 ether, 1, 0);
        uint64 dl = escrow.bounty(id).deadline;
        vm.warp(uint256(dl) + 2 days);
        ShipEscrow.Ships memory a = _att(id, 1);
        a.until = dl;
        escrow.claim(id, a, _sign(a, attesterKey));
        assertEq(wif.balanceOf(builder), 10 ether);
    }

    function test_claimRejectsStaleAttestation() public {
        uint256 id = _open(10 ether, 1, 0);
        vm.warp(block.timestamp + 2 days);
        ShipEscrow.Ships memory a = _att(id, 1);
        bytes memory sig = _sign(a, attesterKey);
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert(ShipEscrow.StaleAttestation.selector);
        escrow.claim(id, a, sig);
    }

    function test_claimRejectsFutureAttestation() public {
        uint256 id = _open(10 ether, 1, 0);
        vm.warp(block.timestamp + 2 days);
        ShipEscrow.Ships memory a = _att(id, 1);
        a.issuedAt = uint64(block.timestamp + 1 hours);
        a.until = a.issuedAt;
        bytes memory sig = _sign(a, attesterKey);
        // until (now + 1 h) is inside the bounty's window, so the age check is what refuses it
        vm.expectRevert(ShipEscrow.StaleAttestation.selector);
        escrow.claim(id, a, sig);
    }

    function test_claimAfterGraceCloses() public {
        uint256 id = _open(10 ether, 1, 0);
        uint64 dl = escrow.bounty(id).deadline;
        vm.warp(uint256(dl) + 3 days + 1);
        ShipEscrow.Ships memory a = _att(id, 1);
        a.until = dl;
        bytes memory sig = _sign(a, attesterKey);
        vm.expectRevert(ShipEscrow.ClaimClosed.selector);
        escrow.claim(id, a, sig);
    }

    function test_attestationForOneEscrowDoesNotWorkOnAnother() public {
        ShipEscrow other = new ShipEscrow(attester);
        vm.prank(alice);
        wif.approve(address(other), type(uint256).max);
        uint256 id = _open(10 ether, 1, 0);
        vm.prank(alice);
        uint256 id2 = other.create(address(wif), builder, SLUG, 1, uint64(block.timestamp + 14 days), 0, 10 ether);
        vm.warp(block.timestamp + 1 days);
        ShipEscrow.Ships memory a = _att(id, 1);
        bytes memory sig = _sign(a, attesterKey); // signed for `escrow`'s domain
        vm.expectRevert(ShipEscrow.BadSignature.selector);
        other.claim(id2, a, sig);
    }

    function test_oneAttestationCanReleaseSeveralBountiesForTheSameProject() public {
        uint256 id1 = _open(10 ether, 1, 0);
        uint256 id2 = _open(20 ether, 2, 0); // same second, same start
        vm.warp(block.timestamp + 1 days);
        ShipEscrow.Ships memory a = _att(id1, 2);
        bytes memory sig = _sign(a, attesterKey);
        escrow.claim(id1, a, sig);
        escrow.claim(id2, a, sig);
        assertEq(wif.balanceOf(builder), 30 ether);
    }

    // ------------------------------------------------------------------ refund

    function test_refundAfterGrace() public {
        uint256 id = _open(100 ether, 5, 0);
        vm.prank(carol);
        escrow.fund(id, 40 ether);
        uint64 dl = escrow.bounty(id).deadline;

        vm.warp(uint256(dl) + 3 days);
        vm.prank(alice);
        vm.expectRevert(ShipEscrow.RefundNotOpen.selector);
        escrow.refund(id);

        vm.warp(uint256(dl) + 3 days + 1);
        uint256 a0 = wif.balanceOf(alice);
        uint256 c0 = wif.balanceOf(carol);
        vm.prank(alice);
        escrow.refund(id);
        vm.prank(carol);
        escrow.refund(id);
        assertEq(wif.balanceOf(alice) - a0, 100 ether);
        assertEq(wif.balanceOf(carol) - c0, 40 ether);
        assertEq(wif.balanceOf(address(escrow)), 0);

        vm.prank(alice);
        vm.expectRevert(ShipEscrow.NothingToRefund.selector);
        escrow.refund(id);
    }

    function test_noRefundAfterClaim() public {
        uint256 id = _open(10 ether, 1, 0);
        vm.warp(block.timestamp + 1 days);
        ShipEscrow.Ships memory a = _att(id, 1);
        escrow.claim(id, a, _sign(a, attesterKey));
        vm.warp(block.timestamp + 30 days);
        vm.prank(alice);
        vm.expectRevert(ShipEscrow.AlreadyPaid.selector);
        escrow.refund(id);
    }

    function test_strangerCannotRefund() public {
        uint256 id = _open(10 ether, 1, 0);
        vm.warp(block.timestamp + 20 days);
        vm.prank(address(0xDEAD1));
        vm.expectRevert(ShipEscrow.NothingToRefund.selector);
        escrow.refund(id);
    }

    // ------------------------------------------------------------------ fee-on-transfer

    function test_feeOnTransferCreditsWhatArrived() public {
        FeeToken fee = new FeeToken();
        fee.mint(alice, 1_000 ether);
        vm.startPrank(alice);
        fee.approve(address(escrow), type(uint256).max);
        uint256 id = escrow.create(address(fee), builder, SLUG, 1, uint64(block.timestamp + 14 days), 0, 100 ether);
        vm.stopPrank();
        assertEq(escrow.bounty(id).total, 99 ether);
        assertEq(escrow.contributed(id, alice), 99 ether);
        vm.warp(block.timestamp + 1 days);
        ShipEscrow.Ships memory a = _att(id, 1);
        escrow.claim(id, a, _sign(a, attesterKey));
        assertEq(fee.balanceOf(address(escrow)), 0);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_payoutConservesFunds(uint96 amtA, uint96 amtC, uint16 burnBps) public {
        burnBps = uint16(bound(burnBps, 0, 1_000));
        uint256 a = bound(amtA, 1, 1_000_000 ether);
        uint256 c = bound(amtC, 0, 1_000_000 ether);
        uint256 id = _open(a, 1, burnBps);
        if (c != 0) {
            vm.prank(carol);
            escrow.fund(id, c);
        }
        vm.warp(block.timestamp + 1 days);
        ShipEscrow.Ships memory att = _att(id, 1);
        escrow.claim(id, att, _sign(att, attesterKey));
        assertEq(wif.balanceOf(builder) + wif.balanceOf(escrow.BURN_ADDRESS()), a + c);
        assertEq(wif.balanceOf(address(escrow)), 0);
        assertLe(wif.balanceOf(escrow.BURN_ADDRESS()), ((a + c) * 1_000) / 10_000);
    }

    function testFuzz_refundsReturnEveryContribution(uint96 amtA, uint96 amtC) public {
        uint256 a = bound(amtA, 1, 1_000_000 ether);
        uint256 c = bound(amtC, 1, 1_000_000 ether);
        uint256 id = _open(a, 1, 0);
        vm.prank(carol);
        escrow.fund(id, c);
        vm.warp(uint256(escrow.bounty(id).deadline) + 3 days + 1);
        vm.prank(carol);
        escrow.refund(id);
        vm.prank(alice);
        escrow.refund(id);
        assertEq(wif.balanceOf(address(escrow)), 0);
        assertEq(wif.balanceOf(alice), 1_000_000 ether);
        assertEq(wif.balanceOf(carol), 1_000_000 ether);
    }
}
