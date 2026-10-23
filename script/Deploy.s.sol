// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ShipEscrow} from "../src/ShipEscrow.sol";

/// @notice Deploys ShipEscrow with HEY's attester address. Run by a person from their own wallet, never from CI:
///   ATTESTER=0x... forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --account <keystore> --verify ...
contract Deploy is Script {
    function run() external returns (ShipEscrow escrow) {
        address attester = vm.envAddress("ATTESTER");
        require(block.chainid == 4663, "Robinhood Chain (4663) only");
        vm.startBroadcast();
        escrow = new ShipEscrow(attester);
        vm.stopBroadcast();
        console2.log("ShipEscrow", address(escrow));
        console2.log("attester  ", attester);
    }
}
