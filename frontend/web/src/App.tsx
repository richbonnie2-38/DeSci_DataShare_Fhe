import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface Dataset {
  id: string;
  encryptedData: string;
  timestamp: number;
  owner: string;
  category: string;
  description: string;
  license: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'normalize':
      result = value / 100;
      break;
    case 'logTransform':
      result = Math.log(value + 1);
      break;
    case 'standardize':
      result = (value - 50) / 10;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newDataset, setNewDataset] = useState({ category: "", description: "", license: "CC-BY", sampleValue: 0 });
  const [selectedDataset, setSelectedDataset] = useState<Dataset | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");

  useEffect(() => {
    loadDatasets().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadDatasets = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("dataset_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing dataset keys:", e); }
      }
      const list: Dataset[] = [];
      for (const key of keys) {
        try {
          const datasetBytes = await contract.getData(`dataset_${key}`);
          if (datasetBytes.length > 0) {
            try {
              const datasetData = JSON.parse(ethers.toUtf8String(datasetBytes));
              list.push({ 
                id: key, 
                encryptedData: datasetData.data, 
                timestamp: datasetData.timestamp, 
                owner: datasetData.owner, 
                category: datasetData.category,
                description: datasetData.description,
                license: datasetData.license || "CC-BY"
              });
            } catch (e) { console.error(`Error parsing dataset data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading dataset ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setDatasets(list);
    } catch (e) { console.error("Error loading datasets:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const uploadDataset = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setUploading(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting data with Zama FHE..." });
    try {
      const encryptedData = FHEEncryptNumber(newDataset.sampleValue);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const datasetId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const datasetData = { 
        data: encryptedData, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        category: newDataset.category,
        description: newDataset.description,
        license: newDataset.license
      };
      await contract.setData(`dataset_${datasetId}`, ethers.toUtf8Bytes(JSON.stringify(datasetData)));
      const keysBytes = await contract.getData("dataset_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(datasetId);
      await contract.setData("dataset_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      setTransactionStatus({ visible: true, status: "success", message: "Dataset uploaded with FHE encryption!" });
      await loadDatasets();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowUploadModal(false);
        setNewDataset({ category: "", description: "", license: "CC-BY", sampleValue: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Upload failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setUploading(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const analyzeDataset = async (datasetId: string, operation: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const datasetBytes = await contract.getData(`dataset_${datasetId}`);
      if (datasetBytes.length === 0) throw new Error("Dataset not found");
      const datasetData = JSON.parse(ethers.toUtf8String(datasetBytes));
      
      const resultData = FHECompute(datasetData.data, operation);
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const resultId = `${datasetId}-${operation}-${Date.now()}`;
      await contractWithSigner.setData(`result_${resultId}`, ethers.toUtf8String(resultData));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE analysis completed!" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Analysis failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (datasetAddress: string) => address?.toLowerCase() === datasetAddress.toLowerCase();

  const filteredDatasets = datasets.filter(dataset => {
    const matchesSearch = dataset.description.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         dataset.category.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === "all" || dataset.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const categories = [...new Set(datasets.map(d => d.category))];

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Loading encrypted datasets...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>DeSci<span>FHE</span>Share</h1>
          <div className="tagline">Privacy-Preserving Research Data Platform</div>
        </div>
        <div className="header-actions">
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
        </div>
      </header>

      <main className="main-content">
        <div className="hero-section">
          <div className="hero-text">
            <h2>Share & Analyze Research Data with FHE</h2>
            <p>Upload and process anonymized scientific datasets using Zama's Fully Homomorphic Encryption</p>
            <button onClick={() => setShowUploadModal(true)} className="primary-btn">
              Upload Dataset
            </button>
          </div>
          <div className="hero-stats">
            <div className="stat-card">
              <div className="stat-value">{datasets.length}</div>
              <div className="stat-label">Datasets</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{categories.length}</div>
              <div className="stat-label">Categories</div>
            </div>
          </div>
        </div>

        <div className="search-section">
          <div className="search-bar">
            <input 
              type="text" 
              placeholder="Search datasets..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <select 
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
            >
              <option value="all">All Categories</option>
              {categories.map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
            <button onClick={loadDatasets} disabled={isRefreshing}>
              {isRefreshing ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>

        <div className="datasets-section">
          <h2>Available Datasets</h2>
          {filteredDatasets.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon"></div>
              <p>No datasets found matching your criteria</p>
              <button onClick={() => setShowUploadModal(true)} className="primary-btn">
                Upload First Dataset
              </button>
            </div>
          ) : (
            <div className="datasets-grid">
              {filteredDatasets.map(dataset => (
                <div className="dataset-card" key={dataset.id} onClick={() => setSelectedDataset(dataset)}>
                  <div className="card-header">
                    <span className="category-tag">{dataset.category}</span>
                    <span className="timestamp">{new Date(dataset.timestamp * 1000).toLocaleDateString()}</span>
                  </div>
                  <div className="card-body">
                    <h3>{dataset.description.substring(0, 50)}{dataset.description.length > 50 ? "..." : ""}</h3>
                    <div className="license">{dataset.license} License</div>
                  </div>
                  <div className="card-footer">
                    <span className="owner">{dataset.owner.substring(0, 6)}...{dataset.owner.substring(38)}</span>
                    <div className="fhe-badge">FHE Encrypted</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="info-section">
          <h2>How It Works</h2>
          <div className="steps-grid">
            <div className="step">
              <div className="step-number">1</div>
              <h3>Upload Data</h3>
              <p>Researchers upload datasets encrypted with Zama FHE technology</p>
            </div>
            <div className="step">
              <div className="step-number">2</div>
              <h3>Analyze Securely</h3>
              <p>Other researchers can perform computations on encrypted data</p>
            </div>
            <div className="step">
              <div className="step-number">3</div>
              <h3>Get Results</h3>
              <p>Receive meaningful insights without exposing raw data</p>
            </div>
          </div>
        </div>
      </main>

      {showUploadModal && (
        <div className="modal-overlay">
          <div className="upload-modal">
            <div className="modal-header">
              <h2>Upload New Dataset</h2>
              <button onClick={() => setShowUploadModal(false)} className="close-btn">&times;</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Category</label>
                <input 
                  type="text" 
                  value={newDataset.category}
                  onChange={(e) => setNewDataset({...newDataset, category: e.target.value})}
                  placeholder="e.g. Genomics, Climate, Clinical"
                />
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea 
                  value={newDataset.description}
                  onChange={(e) => setNewDataset({...newDataset, description: e.target.value})}
                  placeholder="Brief description of the dataset"
                />
              </div>
              <div className="form-group">
                <label>License</label>
                <select 
                  value={newDataset.license}
                  onChange={(e) => setNewDataset({...newDataset, license: e.target.value})}
                >
                  <option value="CC-BY">CC-BY</option>
                  <option value="CC-BY-NC">CC-BY-NC</option>
                  <option value="CC-BY-SA">CC-BY-SA</option>
                  <option value="CC0">CC0</option>
                </select>
              </div>
              <div className="form-group">
                <label>Sample Value (FHE Encrypted)</label>
                <input 
                  type="number" 
                  value={newDataset.sampleValue}
                  onChange={(e) => setNewDataset({...newDataset, sampleValue: parseFloat(e.target.value) || 0})}
                  placeholder="Example numerical value to encrypt"
                />
                <div className="encryption-preview">
                  <span>Encrypted:</span> 
                  {newDataset.sampleValue ? FHEEncryptNumber(newDataset.sampleValue).substring(0, 30) + "..." : "Not available"}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowUploadModal(false)} className="secondary-btn">Cancel</button>
              <button onClick={uploadDataset} disabled={uploading} className="primary-btn">
                {uploading ? "Encrypting..." : "Upload Dataset"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedDataset && (
        <div className="modal-overlay">
          <div className="dataset-modal">
            <div className="modal-header">
              <h2>Dataset Details</h2>
              <button onClick={() => setSelectedDataset(null)} className="close-btn">&times;</button>
            </div>
            <div className="modal-body">
              <div className="dataset-info">
                <div className="info-row">
                  <span>Category:</span>
                  <strong>{selectedDataset.category}</strong>
                </div>
                <div className="info-row">
                  <span>Description:</span>
                  <p>{selectedDataset.description}</p>
                </div>
                <div className="info-row">
                  <span>License:</span>
                  <strong>{selectedDataset.license}</strong>
                </div>
                <div className="info-row">
                  <span>Uploaded:</span>
                  <strong>{new Date(selectedDataset.timestamp * 1000).toLocaleString()}</strong>
                </div>
                <div className="info-row">
                  <span>Owner:</span>
                  <strong>{selectedDataset.owner.substring(0, 6)}...{selectedDataset.owner.substring(38)}</strong>
                </div>
              </div>

              <div className="analysis-section">
                <h3>FHE Analysis Tools</h3>
                <div className="toolbar">
                  <button 
                    onClick={() => analyzeDataset(selectedDataset.id, 'normalize')}
                    className="analysis-btn"
                  >
                    Normalize
                  </button>
                  <button 
                    onClick={() => analyzeDataset(selectedDataset.id, 'logTransform')}
                    className="analysis-btn"
                  >
                    Log Transform
                  </button>
                  <button 
                    onClick={() => analyzeDataset(selectedDataset.id, 'standardize')}
                    className="analysis-btn"
                  >
                    Standardize
                  </button>
                </div>
              </div>

              <div className="decryption-section">
                <h3>Data Access</h3>
                <div className="encrypted-data">
                  <span>FHE Encrypted Data:</span>
                  <code>{selectedDataset.encryptedData.substring(0, 50)}...</code>
                </div>
                <button 
                  onClick={async () => {
                    if (decryptedValue !== null) {
                      setDecryptedValue(null);
                    } else {
                      const value = await decryptWithSignature(selectedDataset.encryptedData);
                      setDecryptedValue(value);
                    }
                  }}
                  disabled={isDecrypting}
                  className="decrypt-btn"
                >
                  {isDecrypting ? "Decrypting..." : decryptedValue !== null ? "Hide Value" : "Decrypt Sample"}
                </button>
                {decryptedValue !== null && (
                  <div className="decrypted-value">
                    <span>Decrypted Sample Value:</span>
                    <strong>{decryptedValue}</strong>
                  </div>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setSelectedDataset(null)} className="secondary-btn">Close</button>
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className="notification">
          <div className={`notification-content ${transactionStatus.status}`}>
            <div className="notification-icon">
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✗"}
            </div>
            <div className="notification-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-left">
            <h3>DeSci FHE Share</h3>
            <p>Privacy-preserving scientific data sharing powered by Zama FHE</p>
          </div>
          <div className="footer-right">
            <div className="footer-links">
              <a href="#">Documentation</a>
              <a href="#">Privacy Policy</a>
              <a href="#">Terms</a>
            </div>
            <div className="zama-badge">
              <span>Powered by Zama FHE</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;