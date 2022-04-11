'use strict';

const chai = require('chai');
const {
  Contract,
  ContractFactory,
  BigNumber,
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

    it('should burn internal token, emit an event, pick up event, attempt destination chain contract call', async () => {

      /*
       *  Source Chain
       */

      const sourceTokenName = 'Test Token A';
      const sourceTokenSymbol = 'srcTestA';
      const decimals = 16;
      const cap = 1e9;
      const initialOwnerWalletTokens = 1e6;

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
                [sourceTokenName, sourceTokenSymbol, decimals, cap, ADDRESS_ZERO],
              ),
              defaultAbiCoder.encode(
                ['string', 'address', 'uint256'],
                [sourceTokenSymbol, ownerWallet.address, initialOwnerWalletTokens],
              ),
            ],
          ],
        ),
      );
      await contract.execute(await getSignedExecuteInput(data, ownerWallet));

      const sourceTokenAddress = await contract.tokenAddresses(sourceTokenSymbol);
      const sourceToken = new Contract(
        sourceTokenAddress,
        BurnableMintableCappedERC20.abi,
        ownerWallet,
      );

      const eoa = ownerWallet.address;
      const spender = contract.address;
      const srcAmount = 600000;
      const chain = 'polygon';
      const destination = nonOwnerWallet.address.toString().replace('0x', '');
      const payload = defaultAbiCoder.encode(
        ['address', 'address'],
        [ownerWallet.address, nonOwnerWallet.address],
      );
      const payloadHash = keccak256(payload);

      await expect(await sourceToken.approve(spender, srcAmount))
        .to.emit(sourceToken, 'Approval')
        .withArgs(eoa, spender, srcAmount);

      const balanceBefore = await sourceToken.balanceOf(eoa);
      expect(balanceBefore).to.be.equal(initialOwnerWalletTokens);

      await expect(
        await contract.callContractWithToken(
          chain,
          destination,
          payload,
          sourceTokenSymbol,
          srcAmount,
        ),
      )
        .to.emit(sourceToken, 'Transfer')
        .withArgs(eoa, ADDRESS_ZERO, srcAmount) 
        // sseefried: This is the Transfer emitted by https://github.com/OpenZeppelin/openzeppelin-contracts/blob/28dd490726f045f7137fa1903b7a6b8a52d6ffcb/contracts/token/ERC20/ERC20.sol#L292
        // in the _burn function
        .to.emit(contract, 'ContractCallWithToken')
        .withArgs(
          eoa,
          chain,
          destination,
          keccak256(payload),
          payload,
          sourceTokenSymbol,
          srcAmount,
        );

      const balanceAfter = await sourceToken.balanceOf(eoa);
      expect(balanceAfter).to.be.equal(initialOwnerWalletTokens - srcAmount);

      ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

      /*
       *  Destination Chain
       */

      const nameA = 'Test Token A';
      const symbolA = 'dstTestA';
      const nameB = 'Test Token B';
      const symbolB = 'dstTestB';
      const initialSupply = 1e6;
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

      await tokenA.mint(contract.address, initialSupply);
      await tokenB.mint(swapper.address, initialSupply);

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


      const dstAmount = srcAmount;
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
                  dstAmount,
                  sourceTxHash,
                  sourceEventIndex,
                ],
              ),
            ],
          ],
        ),
      );

      // AxelarGatewayMultisig.approveContractCallWithMint()
      const approveExecute = await contract.execute(
        await getSignedExecuteInput(approveWithMintData, ownerWallet),
      );

      // listen for ContractCallApprovedWithMint event
      await expect(approveExecute)
        .to.emit(contract, 'ContractCallApprovedWithMint')
        .withArgs(
          commandId,
          sourceChain,
          sourceAddress,
          swapExecutable.address,
          payloadHash,
          symbolA,
          dstAmount,
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
          dstAmount,
        )
        .then((result) => expect(result).to.be.true);

      // External relayer service listens for the ContractApprovalWithMin event and calls executeWithToken
      const swap = swapExecutable.executeWithToken(
        commandId,
        sourceChain,
        sourceAddress,
        payload,
        symbolA,
        dstAmount,
        { gasLimit: 200000 }
      );

      // Unfortunately, the destination contract call reverts because 
      // -- even though 600,000 units of tokenA are minted -- 
      // there are not 1,200,000 (600,000 * 2) units of tokenB. There are only 1,000,000
      await expect(swap).to.be.reverted;

      //
      // But the tokens that were burned on the source chain have still be burned
      // and the user does not get them back.
      //

      const balanceAtEnd = await sourceToken.balanceOf(ownerWallet.address);
      expect(balanceAtEnd).to.be.equal(initialOwnerWalletTokens - srcAmount);

    });
  });
});
