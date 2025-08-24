import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App'; // Import your main App component
import './index.css';

// Create a root to render the React application
const root = ReactDOM.createRoot(document.getElementById('root'));

// Render your App component inside the root
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

