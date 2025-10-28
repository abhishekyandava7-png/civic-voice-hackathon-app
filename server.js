// --- IMPORTS ---
const express = require('express');
const admin = require('firebase-admin');
const { nanoid } = require('nanoid'); // Using nanoid@3.3.4

// --- APP SETUP ---
const app = express();
// Middleware to parse forms and JSON
app.use(express.urlencoded({ extended: true })); 
app.use(express.json()); 

// --- FIREBASE ADMIN SETUP (No Encoding) ---
let db;
// 1. Get the JSON string directly from Vercel's environment variables
const serviceAccountJSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

if (!serviceAccountJSON) {
  console.error("FATAL ERROR: 'FIREBASE_SERVICE_ACCOUNT_JSON' environment variable not found.");
} else {
    try {
        // 2. Parse the JSON string
        const serviceAccount = JSON.parse(serviceAccountJSON);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        db = admin.firestore();
        console.log("Firebase Admin SDK initialized successfully.");
    } catch (error) {
        console.error("FATAL ERROR: Error parsing FIREBASE_SERVICE_ACCOUNT_JSON.");
        console.error(error.message);
    }
}
// --- END FIREBASE SETUP ---


// === API ROUTES ===

// 1. Handle the report submission
app.post('/submit-report', async (req, res) => {
    if (!db) return res.status(500).send("Server database connection error.");
    
    try {
        const { location, description, problem_type, institution } = req.body;
        const trackingCode = nanoid(8).toUpperCase();

        const newReport = {
            id: trackingCode,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            location: location,
            description: description,
            problemType: problem_type,
            institution: institution,
            status: 'Submitted',
            votes: 0 // Initialize votes to 0
        };

        // Save to Firestore
        await db.collection('reports').doc(trackingCode).set(newReport);

        // Redirect back to the main page with the code in the URL
        res.redirect(`/?code=${trackingCode}`);

    } catch (error) {
        console.error("Error submitting report:", error);
        res.status(500).send("An error occurred while processing your report.");
    }
});

// 2. Handle the status check (sends JSON data)
app.get('/check-status', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: 'Database not connected.' });

    try {
        const { code } = req.query;
        if (!code) {
            return res.status(400).json({ success: false, message: 'No code provided.' });
        }

        const doc = await db.collection('reports').doc(code.toUpperCase()).get();

        if (doc.exists) {
            const report = doc.data();
            // Convert Firestore timestamp to a readable string for JSON
            const submittedDate = report.timestamp ? report.timestamp.toDate().toLocaleString() : 'N/A';
            
            // Send a JSON response
            res.json({ 
                success: true, 
                report: { ...report, timestamp: submittedDate } 
            });
        } else {
            // Send a 404 Not Found error
            res.status(404).json({ success: false, message: 'No report found.' });
        }
    } catch (error) {
         console.error("Error checking status:", error);
         res.status(500).json({ success: false, message: 'An error occurred.' });
    }
});

// 3. Handle Mark as Completed
app.post('/mark-completed', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: 'Database not connected.' });

    try {
        const { code } = req.body; // 'code' is the report ID
        const reportRef = db.collection('reports').doc(code);
        await reportRef.update({ status: 'Completed' });
        res.json({ success: true, message: 'Report marked as completed.' });
    } catch (error) {
        console.error("Error marking completed:", error);
        res.status(500).json({ success: false, message: 'An error occurred.' });
    }
});

// 4. Handle a vote for a report
app.post('/vote/:id', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: 'Database not connected.' });

    try {
        const { id } = req.params; // 'id' is the report ID
        const reportRef = db.collection('reports').doc(id);

        // Atomically increment the 'votes' field by 1
        await reportRef.update({
            votes: admin.firestore.FieldValue.increment(1)
        });

        res.json({ success: true, message: 'Vote counted!' });
    } catch (error) {
        console.error("Error voting on report:", error);
        res.status(500).json({ success: false, message: 'An error occurred.' });
    }
});

// 5. Get ALL reports for the public dashboard
app.get('/get-all-reports', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: 'Database not connected.' });

    try {
        const reportsRef = db.collection('reports');
        const snapshot = await reportsRef.get();

        if (snapshot.empty) {
            return res.json([]);
        }

        let reports = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            
            // Check for valid timestamp before converting
            const reportTimestamp = (data.timestamp && typeof data.timestamp.toDate === 'function')
                ? data.timestamp.toDate().toISOString()
                : new Date().toISOString(); // Fallback for old/bad data

            reports.push({
                ...data,
                timestamp: reportTimestamp 
            });
        });

        res.json(reports);

    } catch (error) {
        console.error("Error fetching all reports:", error);
        res.status(500).json({ success: false, message: 'An error occurred.' });
    }
});

// --- VERCEL EXPORT ---
// We no longer need app.listen()
// Vercel will manage the server. We just export the app.
module.exports = app;

