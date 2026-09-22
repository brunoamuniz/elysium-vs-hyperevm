// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice A deliberately minimal testnet transaction target.
contract MinutePulse {
    address public immutable authorizedCaller;
    uint256 public count;

    event Pulsed(address indexed caller, uint256 indexed count, bytes32 entropy);

    constructor(address authorizedCaller_) {
        require(authorizedCaller_ != address(0), "zero caller");
        authorizedCaller = authorizedCaller_;
    }

    function pulse(bytes32 entropy) external {
        require(msg.sender == authorizedCaller, "unauthorized");
        count += 1;
        emit Pulsed(msg.sender, count, entropy);
    }
}
