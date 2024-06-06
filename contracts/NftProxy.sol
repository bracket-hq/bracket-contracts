// SPDX-License-Identifier: MIT

pragma solidity >=0.8.2 <0.9.0;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

contract NftProxy is OwnableUpgradeable {
  address public destination;
  uint256 public minValue;

  event Received(address indexed account, address to, uint256 value);

  function initialize() public initializer {
    __Ownable_init(msg.sender);
  }

  function setDestination(address _destination) public onlyOwner {
    require(_destination != address(0));
    destination = _destination;
  }

  function setMinValue(uint256 _value) public onlyOwner {
    require(_value > 0);
    minValue = _value;
  }

  receive() external payable {
    require(destination != address(0), "Destination not set");
    require(msg.value >= minValue, "Value too low");
    emit Received(msg.sender, destination, msg.value);

    (bool success, ) = destination.call{value: msg.value}("");
    require(success, "Transfer failed");
  }
}
