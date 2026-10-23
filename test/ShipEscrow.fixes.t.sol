// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {ShipEscrow} from "../src/ShipEscrow.sol";

contract FixToken is ERC20 {
    constructor() ERC20("World is Flat", "WIF") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice The adversarial findings, re-run against the patched escrow: each attack now fails.
contract ShipEscrowFixesTest is Test {
    ShipEscrow escrow;
    FixToken wif;
    uint256 attesterKey = 0xA11CE;
    address builder = address(0xB0B);
    address alice = address(0xA1);
    address carol = address(0xCA);
    address mallory = address(0xBAD);
    string constant SLUG = "my-wif-tool";

    function setUp() public {
        vm.warp(1_800_000_000);
        wif = new FixToken();
        escrow = new ShipEscrow(vm.addr(attesterKey), address(wif), address(0));
        address[3] memory who = [alice, carol, mallory];
        for (uint256 i; i < 3; i++) {
            wif.mint(who[i], 1_000_000 ether);
            vm.prank(who[i]);
            wif.approve(address(escrow), type(uint256).max);
        }
    }

    function _create(address as_, address payee, uint256 amount) internal returns (uint256 id) {
        vm.prank(as_);
        id = escrow.create(address(wif), payee, SLUG, 1, uint64(block.timestamp + 14 days), 100, amount);
    }

    /// HEY signs only for the payout address the project verified (here: `builder`).
    function _heyAttests(uint64 since) internal view returns (ShipEscrow.Ships memory a, bytes memory sig) {
        a = ShipEscrow.Ships({
            project: keccak256(bytes(SLUG)),
            builder: builder,
            since: since,
            until: uint64(block.timestamp),
            ships: 5,
            evidence: keccak256("ship:1"),
            issuedAt: uint64(block.timestamp)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterKey, escrow.digest(a));
        sig = abi.encodePacked(r, s, v);
    }

    function test_fix_H1_impostorPayeeCannotClaim() public {
        uint256 id = _create(mallory, mallory, 0);
        vm.prank(carol);
        escrow.fund(id, 500_000 ether);
        vm.warp(block.timestamp + 3 days);
        (ShipEscrow.Ships memory a, bytes memory sig) = _heyAttests(escrow.bounty(id).start);
        vm.expectRevert(ShipEscrow.WrongBuilder.selector);
        escrow.claim(id, a, sig);
        // and an attestation re-labelled with mallory as builder no longer verifies
        a.builder = mallory;
        vm.expectRevert(ShipEscrow.BadSignature.selector);
        escrow.claim(id, a, sig);
        // carol gets her money back after the window
        vm.warp(uint256(escrow.bounty(id).deadline) + 3 days + 1);
        vm.prank(carol);
        escrow.refund(id);
        assertEq(wif.balanceOf(carol), 1_000_000 ether);
    }

    function test_fix_H1_sameSecondImpostorCannotReuseTheLegitAttestation() public {
        uint256 real = _create(alice, builder, 100 ether);
        uint256 fake = _create(mallory, mallory, 100 ether);
        vm.warp(block.timestamp + 2 days);
        (ShipEscrow.Ships memory a, bytes memory sig) = _heyAttests(escrow.bounty(real).start);
        escrow.claim(real, a, sig);
        vm.expectRevert(ShipEscrow.WrongBuilder.selector);
        escrow.claim(fake, a, sig);
        assertEq(wif.balanceOf(builder), 99 ether);
    }

    function test_fix_M_onlyTheEscrowsTokenIsAccepted() public {
        FixToken other = new FixToken();
        vm.prank(mallory);
        vm.expectRevert(ShipEscrow.NotAToken.selector);
        escrow.create(address(other), mallory, SLUG, 1, uint64(block.timestamp + 14 days), 0, 0);
        assertEq(escrow.token(), address(wif));
    }

    function test_fix_L_builderCannotBeTheEscrowTokenOrBurn() public {
        vm.startPrank(alice);
        uint64 dl = uint64(block.timestamp + 14 days);
        vm.expectRevert(ShipEscrow.BadBuilder.selector);
        escrow.create(address(wif), address(escrow), SLUG, 1, dl, 0, 0);
        vm.expectRevert(ShipEscrow.BadBuilder.selector);
        escrow.create(address(wif), address(wif), SLUG, 1, dl, 0, 0);
        vm.expectRevert(ShipEscrow.BadBuilder.selector);
        escrow.create(address(wif), 0x000000000000000000000000000000000000dEaD, SLUG, 1, dl, 0, 0);
        vm.stopPrank();
    }

    function test_fix_L_burnOnAstronomicalTotalDoesNotOverflow() public {
        FixToken huge = new FixToken();
        ShipEscrow e = new ShipEscrow(vm.addr(attesterKey), address(huge), address(0));
        huge.mint(alice, type(uint256).max / 2);
        vm.startPrank(alice);
        huge.approve(address(e), type(uint256).max);
        uint256 id = e.create(address(huge), builder, SLUG, 1, uint64(block.timestamp + 14 days), 1_000, type(uint256).max / 2);
        vm.stopPrank();
        vm.warp(block.timestamp + 1 days);
        ShipEscrow.Ships memory a = ShipEscrow.Ships({
            project: keccak256(bytes(SLUG)),
            builder: builder,
            since: e.bounty(id).start,
            until: uint64(block.timestamp),
            ships: 1,
            evidence: 0,
            issuedAt: uint64(block.timestamp)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterKey, e.digest(a));
        e.claim(id, a, abi.encodePacked(r, s, v));
        assertEq(huge.balanceOf(e.BURN_ADDRESS()) + huge.balanceOf(builder), type(uint256).max / 2);
    }

    function test_fix_constructorRejectsBadToken() public {
        vm.expectRevert(ShipEscrow.ZeroAddress.selector);
        new ShipEscrow(address(1), address(0), address(0));
        vm.expectRevert(ShipEscrow.NotAToken.selector);
        new ShipEscrow(address(1), address(0x1234), address(0));
    }

    function test_fix_guardianRetireOpensRefundsAndStopsClaims() public {
        address guardian = address(0x6A);
        ShipEscrow e = new ShipEscrow(vm.addr(attesterKey), address(wif), guardian);
        vm.prank(carol);
        wif.approve(address(e), type(uint256).max);
        vm.prank(carol);
        uint256 id = e.create(address(wif), builder, SLUG, 1, uint64(block.timestamp + 14 days), 0, 100 ether);

        vm.prank(mallory);
        vm.expectRevert(ShipEscrow.NotGuardian.selector);
        e.retire();
        vm.prank(guardian);
        e.retire();

        vm.warp(block.timestamp + 1 days);
        ShipEscrow.Ships memory a = ShipEscrow.Ships({
            project: keccak256(bytes(SLUG)), builder: builder, since: e.bounty(id).start,
            until: uint64(block.timestamp), ships: 9, evidence: 0, issuedAt: uint64(block.timestamp)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterKey, e.digest(a)); // the leaked key
        vm.expectRevert(ShipEscrow.Retired.selector);
        e.claim(id, a, abi.encodePacked(r, s, v));
        vm.prank(carol);
        vm.expectRevert(ShipEscrow.Retired.selector);
        e.fund(id, 1 ether);
        vm.prank(carol);
        e.refund(id); // before the deadline
        assertEq(wif.balanceOf(carol), 1_000_000 ether);
    }

    function test_fix_noGuardianMeansNoRetire() public {
        vm.prank(address(0));
        vm.expectRevert(ShipEscrow.NotGuardian.selector);
        escrow.retire();
    }
}
