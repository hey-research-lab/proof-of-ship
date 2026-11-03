// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {ShipEscrow} from "../src/ShipEscrow.sol";

/// @dev A token with a transfer hook (as ERC-777 or a malicious token would have): every transfer that is not a mint
///      calls the hook contract, which tries to re-enter the escrow.
contract HookToken is ERC20 {
    Reenterer public hook;

    constructor() ERC20("Hook", "HOOK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHook(Reenterer hook_) external {
        hook = hook_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && address(hook) != address(0)) hook.hit();
    }
}

/// @dev Re-enters the escrow from inside a token transfer.
contract Reenterer {
    enum Action {
        None,
        Claim,
        Refund,
        Fund
    }

    ShipEscrow public escrow;
    Action public action;
    uint256 public id;
    ShipEscrow.Ships internal att;
    bytes internal sig;

    function arm(ShipEscrow escrow_, Action action_, uint256 id_) external {
        escrow = escrow_;
        action = action_;
        id = id_;
    }

    function load(ShipEscrow.Ships calldata att_, bytes calldata sig_) external {
        att = att_;
        sig = sig_;
    }

    function approve(ERC20 t, address spender) external {
        t.approve(spender, type(uint256).max);
    }

    function fund(uint256 id_, uint256 amount) external {
        escrow.fund(id_, amount);
    }

    function refund(uint256 id_) external {
        escrow.refund(id_);
    }

    function hit() external {
        Action a = action;
        if (a == Action.None) return;
        action = Action.None; // one attempt
        if (a == Action.Claim) escrow.claim(id, att, sig);
        else if (a == Action.Refund) escrow.refund(id);
        else escrow.fund(id, 1 ether);
    }
}

/// @notice Replays across chains, malleable signatures and reentrant tokens: each fails.
contract ShipEscrowReplayTest is Test {
    ShipEscrow escrow;
    HookToken token;
    Reenterer attacker;
    uint256 attesterKey = 0xA11CE;
    address builder = address(0xB0B);
    address alice = address(0xA1);
    string constant SLUG = "my-wif-tool";

    // secp256k1 group order
    uint256 constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new HookToken();
        escrow = new ShipEscrow(vm.addr(attesterKey), address(token), address(0));
        attacker = new Reenterer();
        token.mint(alice, 1_000_000 ether);
        token.mint(address(attacker), 1_000_000 ether);
        vm.prank(alice);
        token.approve(address(escrow), type(uint256).max);
        attacker.approve(token, address(escrow));
    }

    function _open(address payee, uint256 amount) internal returns (uint256 id) {
        vm.prank(alice);
        id = escrow.create(address(token), payee, SLUG, 1, uint64(block.timestamp + 14 days), 0, amount);
    }

    function _att(uint256 id, address payee) internal view returns (ShipEscrow.Ships memory a) {
        a = ShipEscrow.Ships({
            project: keccak256(bytes(SLUG)),
            builder: payee,
            since: escrow.bounty(id).start,
            until: uint64(block.timestamp),
            ships: 2,
            evidence: keccak256("ship:1,ship:2"),
            issuedAt: uint64(block.timestamp)
        });
    }

    function _sign(ShipEscrow.Ships memory a) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        (v, r, s) = vm.sign(attesterKey, escrow.digest(a));
    }

    // ------------------------------------------------------------------ chain replay

    /// An attestation signed while the escrow sits on one chain does not verify after the chain id changes (a fork,
    /// or the same address on another chain): the domain separator is rebuilt from the current chain id.
    function test_attestationDoesNotReplayOnAnotherChain() public {
        uint256 id = _open(builder, 10 ether);
        vm.warp(block.timestamp + 1 days);
        ShipEscrow.Ships memory a = _att(id, builder);
        (uint8 v, bytes32 r, bytes32 s) = _sign(a);
        bytes memory sig = abi.encodePacked(r, s, v);
        bytes32 before = escrow.domainSeparator();

        uint256 home = block.chainid;
        vm.chainId(home + 1);
        assertTrue(escrow.domainSeparator() != before);
        vm.expectRevert(ShipEscrow.BadSignature.selector);
        escrow.claim(id, a, sig);

        vm.chainId(home);
        escrow.claim(id, a, sig);
        assertEq(token.balanceOf(builder), 10 ether);
    }

    // ------------------------------------------------------------------ malleability

    /// The same signature in its high-s form (s' = n - s, v flipped) recovers the same key in raw ecrecover, but the
    /// escrow refuses it: OpenZeppelin's ECDSA rejects s above n/2.
    function test_highSSignatureIsRefused() public {
        uint256 id = _open(builder, 10 ether);
        vm.warp(block.timestamp + 1 days);
        ShipEscrow.Ships memory a = _att(id, builder);
        (uint8 v, bytes32 r, bytes32 s) = _sign(a);

        bytes32 highS = bytes32(N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        assertEq(ecrecover(escrow.digest(a), flippedV, r, highS), vm.addr(attesterKey)); // malleable in raw form

        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, highS));
        escrow.claim(id, a, abi.encodePacked(r, highS, flippedV));

        escrow.claim(id, a, abi.encodePacked(r, s, v)); // the canonical form still pays
        assertEq(token.balanceOf(builder), 10 ether);
    }

    // ------------------------------------------------------------------ reentrancy

    /// The builder's token hook tries to claim again while the first payout is moving.
    function test_reentrantClaimFromPayoutReverts() public {
        uint256 id = _open(address(attacker), 10 ether);
        vm.warp(block.timestamp + 1 days);
        ShipEscrow.Ships memory a = _att(id, address(attacker));
        (uint8 v, bytes32 r, bytes32 s) = _sign(a);
        bytes memory sig = abi.encodePacked(r, s, v);
        attacker.load(a, sig);
        attacker.arm(escrow, Reenterer.Action.Claim, id);
        token.setHook(attacker);

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        escrow.claim(id, a, sig);
        assertFalse(escrow.bounty(id).paid);
        assertEq(token.balanceOf(address(escrow)), 10 ether);
    }

    /// A funder's token hook tries to refund twice inside its own refund.
    function test_reentrantRefundReverts() public {
        uint256 id = _open(builder, 0);
        attacker.arm(escrow, Reenterer.Action.None, id);
        attacker.fund(id, 100 ether);
        vm.warp(uint256(escrow.bounty(id).deadline) + 3 days + 1);

        attacker.arm(escrow, Reenterer.Action.Refund, id);
        token.setHook(attacker);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.refund(id);
        assertEq(escrow.contributed(id, address(attacker)), 100 ether);
        assertEq(token.balanceOf(address(escrow)), 100 ether);
    }

    /// A funder's token hook tries to fund again while the first deposit is being credited.
    function test_reentrantFundReverts() public {
        uint256 id = _open(builder, 0);
        attacker.arm(escrow, Reenterer.Action.Fund, id);
        token.setHook(attacker);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.fund(id, 100 ether);
        assertEq(escrow.bounty(id).total, 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }
}
