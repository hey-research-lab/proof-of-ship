// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {ShipEscrow} from "../src/ShipEscrow.sol";

/// @notice The full flow against the real $WIF on a local fork of Robinhood Chain. Nothing is broadcast.
///         Runs only when FORK_RPC is set:  FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --mc Fork
contract ShipEscrowForkTest is Test {
    address constant WIF = 0x5173b8eA6923c2d40267890D45C46a3480954773;
    uint256 attesterKey = 0xA11CE;

    function test_realWifBountyFlow() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 4663);

        ShipEscrow escrow = new ShipEscrow(vm.addr(attesterKey), WIF, address(0));
        address funder = makeAddr("funder");
        address builder = makeAddr("builder");
        deal(WIF, funder, 1_000_000 ether);

        vm.startPrank(funder);
        IERC20(WIF).approve(address(escrow), type(uint256).max);
        uint256 id = escrow.create(WIF, builder, "my-wif-tool", 2, uint64(block.timestamp + 10 days), 100, 1_000_000 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + 2 days);
        ShipEscrow.Ships memory a = ShipEscrow.Ships({
            project: keccak256("my-wif-tool"),
            builder: builder,
            since: escrow.bounty(id).start,
            until: uint64(block.timestamp),
            ships: 2,
            evidence: keccak256("ship:a,ship:b"),
            issuedAt: uint64(block.timestamp)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterKey, escrow.digest(a));
        uint256 dead0 = IERC20(WIF).balanceOf(escrow.BURN_ADDRESS());
        escrow.claim(id, a, abi.encodePacked(r, s, v));

        assertEq(IERC20(WIF).balanceOf(builder), 990_000 ether);
        assertEq(IERC20(WIF).balanceOf(escrow.BURN_ADDRESS()) - dead0, 10_000 ether);
        assertEq(IERC20(WIF).balanceOf(address(escrow)), 0);
    }
}
