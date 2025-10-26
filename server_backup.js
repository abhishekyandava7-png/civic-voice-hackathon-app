const express = require('express');
const admin = require('firebase-admin');
const { nanoid } = require('nanoid');
// const path = require('path'); // No longer needed for file serving

const app = express();
app.use(express.urlencoded({ extended: true })); // Middleware for forms
app.use(express.json()); // Middleware for parsing JSON (for vote/complete)
// const port = 3000; // Vercel handles the port

// --- Firebase Admin Setup (FOR VERCEL - No Encoding) ---

// 1. Get the JSON string directly from Vercel's environment variables
// Note: We are using a NEW variable name here.
const serviceAccountJSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

if (!serviceAccountJSON) {
  console.error("Firebase service account JSON not found in environment variables. Make sure the variable is named FIREBASE_SERVICE_ACCOUNT_JSON.");
}

// 2. Parse the JSON string
// The previous error was because we were trying to parse a Base64 string.
// This will parse the actual JSON content.
const serviceAccount = JSON.parse(serviceAccountJSON);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
// --- End Firebase Setup ---


// --- API ROUTES ---
// We removed app.get('/') and app.get('/dashboard')
// Vercel.json now handles serving those static files.

// 2. Handle the report submission
app.post('/submit-report', async (req, res) => {
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
            votes: 0
        };

        // Save to Firestore
        await db.collection('reports').doc(trackingCode).set(newReport);

        // Redirect back to the main page with the code in the URL
        // Vercel will correctly serve app.html at '/'
        res.redirect(`/?code=${trackingCode}`);

    } catch (error) {
        console.error("Error submitting report:", error);
        res.status(500).send("An error occurred while processing your report.");
    }
});

// 3. Handle the status check (sends JSON data)
app.get('/check-status', async (req, res) => {
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

// 4. Handle Mark as Completed
app.post('/mark-completed', async (req, res) => {
    try {
        const { code } = req.body;
        const reportRef = db.collection('reports').doc(code);
        await reportRef.update({ status: 'Completed' });
        res.json({ success: true, message: 'Report marked as completed.' });
    } catch (error) {
        console.error("Error marking completed:", error);
        res.status(500).json({ success: false, message: 'An error occurred.' });
    }
});

// 5. Handle a vote for a report
app.post('/vote/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const reportRef = db.collection('reports').doc(id);

        // Atomically increment the 'votes' field by 1
        await reportRef.update({
            votes: admin.firestore.FieldValue.increment(1)
        });

        res.json({ success: true, message: 'Vote counted!' });
    } catch (error) {
        console.error("Error voting on report:", error);
        res.status(Additional.json({ success: false, message: 'An error occurred.' }));
    }
});

// 6. Get ALL reports for the public dashboard
app.get('/get-all-reports', async (req, res) => {
    try {
        const reportsRef = db.collection('reports');
        const snapshot = await reportsRef.get();

        if (snapshot.empty) {
            return res.json([]);
        }

        let reports = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            reports.push({
                ...data,
                // Convert timestamp to a standard ISO string for JavaScript
                timestamp: data.timestamp.toDate().toISOString() 
            });
        });

        res.json(reports);

    } catch (error) {
        console.error("Error fetching all reports:", error);
        res.status(500).json({ success: false, message: 'An error occurred.' });
    }
});

// We no longer need app.listen()
// Vercel will manage the server. We just export the app.
module.exports = app;

