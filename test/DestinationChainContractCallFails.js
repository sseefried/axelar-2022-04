'use strict';

const chai = require('chai');
const {
  Contract,
  ContractFactory,
  utils: {
    defaultAbiCoder,
    id,
    arrayify,
    keccak256,
    getCreate2Address,
    randomBytes,
  },
} = require('ethers');
const { deployContract, MockProvider, solidity } = require('ethereum-waffle');
chai.use(solidity);
const { expect } = chai;
const { get } = require('lodash/fp');

const CHAIN_ID = 1;
const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000';
const ROLE_OWNER = 1;
const ROLE_OPERATOR = 2;

const TokenDeployer = require('../build/TokenDeployer.json');
const AxelarGatewayProxy = require('../build/AxelarGatewayProxy.json');
const AxelarGatewaySinglesig = require('../build/AxelarGatewaySinglesig.json');
const BurnableMintableCappedERC20 = require('../build/BurnableMintableCappedERC20.json');
const MintableCappedERC20 = require('../build/MintableCappedERC20.json');
const DepositHandler = require('../build/DepositHandler.json');
const DestinationSwapExecutable = require('../build/DestinationSwapExecutable.json');
const TokenSwapper = require('../build/TokenSwapper.json');
const {
  bigNumberToNumber,
  getSignedExecuteInput,
  getRandomID,
} = require('./utils');

describe('DestinationChainContractCallFails', () => {
  const [
    ownerWallet,
    operatorWallet,
    nonOwnerWallet,
    adminWallet1,
    adminWallet2,
    adminWallet3,
    adminWallet4,
    adminWallet5,
    adminWallet6,
  ] = new MockProvider().getWallets();
  const adminWallets = [
    adminWallet1,
    adminWallet2,
    adminWallet3,
    adminWallet4,
    adminWallet5,
    adminWallet6,
  ];
  const threshold = 3;

  let contract;
  let tokenDeployer;

  const freezeToken = (symbol) =>
    Promise.all(
      adminWallets
        .slice(0, 3)
        .map((wallet) =>
          contract.connect(wallet).freezeToken(symbol, { gasLimit: 200000 }),
        ),
    );
  const unfreezeToken = (symbol) =>
    Promise.all(
      adminWallets
        .slice(0, 3)
        .map((wallet) =>
          contract.connect(wallet).unfreezeToken(symbol, { gasLimit: 200000 }),
        ),
    );

  const freezeAllTokens = () =>
    Promise.all(
      adminWallets
        .slice(0, 3)
        .map((wallet) =>
          contract.connect(wallet).freezeAllTokens({ gasLimit: 200000 }),
        ),
    );
  const unfreezeAllTokens = () =>
    Promise.all(
      adminWallets
        .slice(0, 3)
        .map((wallet) =>
          contract.connect(wallet).unfreezeAllTokens({ gasLimit: 200000 }),
        ),
    );

  beforeEach(async () => {
    const params = arrayify(
      defaultAbiCoder.encode(
        ['address[]', 'uint8', 'address', 'address'],
        [
          adminWallets.map(get('address')),
          threshold,
          ownerWallet.address,
          operatorWallet.address,
        ],
      ),
    );
    tokenDeployer = await deployContract(ownerWallet, TokenDeployer);
    const gateway = await deployContract(ownerWallet, AxelarGatewaySinglesig, [
      tokenDeployer.address,
    ]);
    const proxy = await deployContract(ownerWallet, AxelarGatewayProxy, [
      gateway.address,
      params,
    ]);
    contract = new Contract(
      proxy.address,
      AxelarGatewaySinglesig.abi,
      ownerWallet,
    );
  });



  describe('external contract execution', () => {

    it('should burn internal token and emit an event', async () => {
      const tokenName = 'Test Token';
      const tokenSymbol = 'TEST';
      const decimals = 18;
      const cap = 1e9;

      const data = arrayify(
        defaultAbiCoder.encode(
          ['uint256', 'uint256', 'bytes32[]', 'string[]', 'bytes[]'],
          [
            CHAIN_ID,
            ROLE_OWNER,
            [getRandomID(), getRandomID()],
            ['deployToken', 'mintToken'],
            [
              defaultAbiCoder.encode(
                ['string', 'string', 'uint8', 'uint256', 'address'],
                [tokenName, tokenSymbol, decimals, cap, ADDRESS_ZERO],
              ),
              defaultAbiCoder.encode(
                ['string', 'address', 'uint256'],
                [tokenSymbol, ownerWallet.address, 1e6],
              ),
            ],
          ],
        ),
      );
      await contract.execute(await getSignedExecuteInput(data, ownerWallet));

      const tokenAddress = await contract.tokenAddresses(tokenSymbol);
      const token = new Contract(
        tokenAddress,
        BurnableMintableCappedERC20.abi,
        ownerWallet,
      );

      const eoa = ownerWallet.address;
      const spender = contract.address;
      const amount = 1000;
      const chain = 'polygon';
      const destination = nonOwnerWallet.address.toString().replace('0x', '');
      const payload = defaultAbiCoder.encode(
        ['address', 'address'],
        [ownerWallet.address, nonOwnerWallet.address],
      );

      await expect(await token.approve(spender, amount))
        .to.emit(token, 'Approval')
        .withArgs(eoa, spender, amount);

      console.log((await token.balanceOf(eoa)).toNumber()); // sseefried: Balance before

      await expect(
        await contract.callContractWithToken(
          chain,
          destination,
          payload,
          tokenSymbol,
          amount,
        ),
      )
        .to.emit(token, 'Transfer')
        .withArgs(eoa, ADDRESS_ZERO, amount) 
        // sseefried: This is the Transfer emitted by https://github.com/OpenZeppelin/openzeppelin-contracts/blob/28dd490726f045f7137fa1903b7a6b8a52d6ffcb/contracts/token/ERC20/ERC20.sol#L292
        // in the _burn function
        .to.emit(contract, 'ContractCallWithToken')
        .withArgs(
          eoa,
          chain,
          destination,
          keccak256(payload),
          payload,
          tokenSymbol,
          amount,
        );

      console.log((await token.balanceOf(eoa)).toNumber()); // sseefried: Balance after


    });


    it('should approve to call external TokenSwapper contract', async () => {
      const nameA = 'testA';
      const symbolA = 'testA';
      const nameB = 'testB';
      const symbolB = 'testB';
      const decimals = 16;
      const capacity = 0;

      const tokenA = await deployContract(ownerWallet, MintableCappedERC20, [
        nameA,
        symbolA,
        decimals,
        capacity,
      ]);

      const tokenB = await deployContract(ownerWallet, MintableCappedERC20, [
        nameB,
        symbolB,
        decimals,
        capacity,
      ]);

      const swapper = await deployContract(ownerWallet, TokenSwapper, [
        tokenA.address,
        tokenB.address,
      ]);

      const swapExecutable = await deployContract(
        ownerWallet,
        DestinationSwapExecutable,
        [contract.address, swapper.address],
      );

      await tokenA.mint(contract.address, 1e6);
      await tokenB.mint(swapper.address, 1e6);

      const deployTokenData = arrayify(
        defaultAbiCoder.encode(
          ['uint256', 'uint256', 'bytes32[]', 'string[]', 'bytes[]'],
          [
            CHAIN_ID,
            ROLE_OWNER,
            [getRandomID()],
            ['deployToken'],
            [
              defaultAbiCoder.encode(
                ['string', 'string', 'uint8', 'uint256', 'address'],
                [nameA, symbolA, decimals, capacity, tokenA.address],
              ),
            ],
          ],
        ),
      );

      await getSignedExecuteInput(deployTokenData, ownerWallet).then((input) =>
        expect(contract.execute(input))
          .to.emit(contract, 'TokenDeployed')
          .withArgs(symbolA, tokenA.address),
      );

      const payload = defaultAbiCoder.encode(
        ['address', 'address'],
        [tokenB.address, nonOwnerWallet.address],
      );
      const payloadHash = keccak256(payload);
      const swapAmount = 600000; // sseefried: Make the swap amount too high
      const commandId = getRandomID();
      const sourceChain = 'polygon';
      const sourceAddress = 'address0x123';
      const sourceTxHash = keccak256('0x123abc123abc');
      const sourceEventIndex = 17;

      const approveWithMintData = arrayify(
        defaultAbiCoder.encode(
          ['uint256', 'uint256', 'bytes32[]', 'string[]', 'bytes[]'],
          [
            CHAIN_ID,
            ROLE_OWNER,
            [commandId],
            ['approveContractCallWithMint'],
            [
              defaultAbiCoder.encode(
                [
                  'string',
                  'string',
                  'address',
                  'bytes32',
                  'string',
                  'uint256',
                  'bytes32',
                  'uint256',
                ],
                [
                  sourceChain,
                  sourceAddress,
                  swapExecutable.address,
                  payloadHash,
                  symbolA,
                  swapAmount,
                  sourceTxHash,
                  sourceEventIndex,
                ],
              ),
            ],
          ],
        ),
      );

      const approveExecute = await contract.execute(
        await getSignedExecuteInput(approveWithMintData, ownerWallet),
      );

      await expect(approveExecute)
        .to.emit(contract, 'ContractCallApprovedWithMint')
        .withArgs(
          commandId,
          sourceChain,
          sourceAddress,
          swapExecutable.address,
          payloadHash,
          symbolA,
          swapAmount,
          sourceTxHash,
          sourceEventIndex,
        )

      const result = await contract
        .isContractCallAndMintApproved(
          commandId,
          sourceChain,
          sourceAddress,
          swapExecutable.address,
          payloadHash,
          symbolA,
          swapAmount,
        )
        .then((result) => expect(result).to.be.true);

      const swap = swapExecutable.executeWithToken(
        commandId,
        sourceChain,
        sourceAddress,
        payload,
        symbolA,
        swapAmount,
        { gasLimit: 200000 }
      );

      // This reverts because even though 600,000 units of tokenA are minted,
      //  since there is not 600,000 * 2 = 1,200,000 units of tokenB.
      await expect(swap).to.be.reverted;

      //
      // But the tokens that were burned on the source chain have still be burned.
      //


    });
  });
});
