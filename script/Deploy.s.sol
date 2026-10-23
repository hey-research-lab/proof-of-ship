// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ShipEscrow} from "../src/ShipEscrow.sol";

/// @notice Deploys ShipEscrow with HEY's attester address. Run by a person from their own wallet, never from CI:
///   ATTESTER=0x... [TOKEN=0x...] forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --account <keystore> --verify ...
contract Deploy is Script {
    function run() external returns (ShipEscrow escrow) {
        address attester = vm.envAddress("ATTESTER");
        // $WIF on Robinhood Chain unless TOKEN says otherwise.
        address token = vm.envOr("TOKEN", address(0x5173b8eA6923c2d40267890D45C46a3480954773));
        require(block.chainid == 4663, "Robinhood Chain (4663) only");
        // A cold key (hardware wallet / multisig) that can only retire the escrow and open refunds. Unset = none.
        address guardian = vm.envOr("GUARDIAN", address(0));
        vm.startBroadcast();
        escrow = new ShipEscrow(attester, token, guardian);
        vm.stopBroadcast();
        console2.log("ShipEscrow", address(escrow));
        console2.log("attester  ", attester);
        console2.log("token     ", token);
        console2.log("guardian  ", guardian);
    }
}
