// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract USBG is ERC20, Ownable {
    event sendAirdrop(address receiver, uint256 amtsent);

    // Constructor to initialize the ERC20 token with name and symbol
    constructor(string memory name, string memory symbol) Ownable(msg.sender) ERC20(name, symbol) {}

    // Override decimals to set it to 6
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // Airdrop function to mint new tokens to a given address
    // Only owner of the contract can call this function
    function airdrop(address receiver, uint256 howMuch) public onlyOwner {
        _mint(receiver, howMuch * 10 ** uint(decimals()));
        emit sendAirdrop(receiver, howMuch * 10 ** uint(decimals()));
    }
}
