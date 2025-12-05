pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract DeSciDataShareFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        bool isOpen;
        uint256 dataCount;
    }
    mapping(uint256 => Batch) public batches;
    uint256 public currentBatchId;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PauseToggled(bool indexed paused);
    event CooldownSecondsSet(uint256 indexed oldCooldown, uint256 indexed newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event DataSubmitted(address indexed provider, uint256 indexed batchId, uint256 dataId, bytes32 encryptedData);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 average);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosedOrInvalid();
    error InvalidCooldown();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        emit ProviderAdded(owner);
        currentBatchId = 1;
        _openBatch(currentBatchId);
        cooldownSeconds = 60; // Default 1 minute cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseToggled(_paused);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds == 0) revert InvalidCooldown();
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsSet(oldCooldown, newCooldownSeconds);
    }

    function openNewBatch() external onlyOwner whenNotPaused {
        _closeBatch(currentBatchId);
        currentBatchId++;
        _openBatch(currentBatchId);
    }

    function _openBatch(uint256 batchId) internal {
        batches[batchId] = Batch({isOpen: true, dataCount: 0});
        emit BatchOpened(batchId);
    }

    function _closeBatch(uint256 batchId) internal {
        if (batchId >= currentBatchId && batches[batchId].isOpen) {
            batches[batchId].isOpen = false;
            emit BatchClosed(batchId);
        }
    }

    function submitData(euint32 encryptedData) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!batches[currentBatchId].isOpen) {
            revert BatchClosedOrInvalid();
        }

        lastSubmissionTime[msg.sender] = block.timestamp;
        batches[currentBatchId].dataCount++;
        // In a real scenario, encryptedData would be stored, keyed by a unique dataId.
        // For this example, we'll just emit it.
        emit DataSubmitted(msg.sender, currentBatchId, batches[currentBatchId].dataCount, encryptedData.toBytes32());
    }

    function requestAverageDecryption(uint256 batchId) external whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!_isValidBatchForAnalysis(batchId)) revert BatchClosedOrInvalid();

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        euint32 encryptedSum;
        euint32 encryptedCount;
        bool initialized = false;

        for (uint256 i = 1; i <= batches[batchId].dataCount; i++) {
            // In a real scenario, encryptedData would be fetched from storage.
            // For this example, we'll use a placeholder.
            // euint32 memory encryptedData = getEncryptedData(batchId, i);
            // For demonstration, we'll use FHE.asEuint32(0) as a placeholder.
            // This means the actual sum will be 0. Replace with actual data retrieval.
            euint32 memory encryptedData = FHE.asEuint32(0); 

            _initIfNeeded(encryptedSum, initialized);
            encryptedSum = encryptedSum.add(encryptedData);
        }
        encryptedCount = FHE.asEuint32(batches[batchId].dataCount);

        euint32 memory encryptedAverage = encryptedSum.mul(FHE.inv(encryptedCount)); // FHE.inv is a placeholder for 1/count

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = encryptedAverage.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({batchId: batchId, stateHash: stateHash, processed: false});
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        // Rebuild cts in the exact same order as in requestAverageDecryption
        // This requires re-calculating the encrypted average for the batch.
        // This simplified version assumes the batch data is static between request and callback.
        // For a more robust solution, the individual ciphertexts that formed the average
        // should be stored or re-computed and hashed.
        // Here, we'll re-calculate the average for the batchId stored in the context.
        uint256 batchId = decryptionContexts[requestId].batchId;
        euint32 encryptedSum;
        euint32 encryptedCount;
        bool initialized = false;
        for (uint256 i = 1; i <= batches[batchId].dataCount; i++) {
            // euint32 memory encryptedData = getEncryptedData(batchId, i); // Placeholder
            euint32 memory encryptedData = FHE.asEuint32(0); 
            _initIfNeeded(encryptedSum, initialized);
            encryptedSum = encryptedSum.add(encryptedData);
        }
        encryptedCount = FHE.asEuint32(batches[batchId].dataCount);
        euint32 memory encryptedAverage = encryptedSum.mul(FHE.inv(encryptedCount));

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = encryptedAverage.toBytes32();
        
        bytes32 currentHash = _hashCiphertexts(cts); // Recalculate hash from current state

        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        try FHE.checkSignatures(requestId, cleartexts, proof) {
            // If checkSignatures succeeds, it doesn't throw
        } catch {
            revert InvalidProof();
        }

        uint256 average = abi.decode(cleartexts, (uint256));
        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batchId, average);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 storage target, bool initialized) internal {
        if (!initialized) {
            target = FHE.asEuint32(0);
        }
    }

    function _requireInitialized(euint32 x) internal view {
        if (!FHE.isInitialized(x)) revert("FHE: Not initialized");
    }

    function _isValidBatchForAnalysis(uint256 batchId) internal view returns (bool) {
        return batchId <= currentBatchId && batchId > 0 && !batches[batchId].isOpen && batches[batchId].dataCount > 0;
    }
}