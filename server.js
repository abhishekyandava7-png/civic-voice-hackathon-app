// --- IMPORTS ---
const express = require('express');
const admin = require('firebase-admin');
const { nanoid } = require('nanoid');
const crypto = require('crypto');
const bodyParser = require('body-parser');

// --- APP SETUP ---
const app = express();
app.use(bodyParser.json()); // Use body-parser for JSON
app.use(bodyParser.urlencoded({ extended: true })); // for HTML forms
app.use(express.static('public')); // Serve files from 'public' folder

// --- FIREBASE ADMIN SETUP ---
let db; 
const serviceAccountJSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

if (!serviceAccountJSON) {
  console.error("FATAL ERROR: 'FIREBASE_SERVICE_ACCOUNT_JSON' environment variable not found.");
} else {
    try {
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


// --- CONSTANTS ---
const MIN_VOTES_TO_CONFIRM = 5;
const MIN_VOTES_TO_CONTEST = 5;

// === HELPER FUNCTION: THE "JUDGE" (STEP 4) ===
async function judgeReport(reportId) {
    if (!db) {
        console.error("JudgeReport failed: Firestore (db) is not initialized.");
        return;
    }
    
    const reportRef = db.collection('reports').doc(reportId);
    try {
        const doc = await reportRef.get();
        if (!doc.exists) return; 

        const report = doc.data();

        // Only judge reports that are "InReview"
        if (report.status !== 'InReview') {
            return; 
        }

        // SCENARIO A: The "Honest Citizen" (Passed Review)
        if (report.approveVotes >= MIN_VOTES_TO_CONFIRM && report.approveVotes > report.challengeVotes) {
            console.log(`Report ${reportId} PASSED review.`);
            // 1. Update status
            await reportRef.update({ status: 'Confirmed' });
            // 2. Create the Golden Key
            await db.collection('goldenKeys').doc(report.key_hash).set({
                originalReportId: reportId,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`Golden Key created for ${reportId}`);
        }
        // SCENARIO B: The "Corrupt Goon" (Failed Review)
        else if (report.challengeVotes >= MIN_VOTES_TO_CONTEST) {
            console.log(`Report ${reportId} FAILED review.`);
            // 1. Update status
            await reportRef.update({ status: 'Contested' });
            console.log(`Report ${reportId} marked as 'Contested'. No key created.`);
        }
    } catch (error) {
        console.error(`Error in judgeReport for ${reportId}:`, error);
    }
}


// === API ROUTES ===

// 1. SUBMIT REPORT (STEP 1)
app.post('/submit-report', async (req, res) => {
    if (!db) {
        console.error("Cannot submit report: Firestore (db) is not initialized.");
        return res.status(500).send("Server database connection error. Check server logs.");
    }
    
    try {
        const { description, location, institution, problem_type } = req.body;
        
        // Key generation and hashing
        const userKey = crypto.randomBytes(4).toString('hex').toUpperCase(); 
        const keyHash = crypto.createHash('sha256').update(userKey).digest('hex');
        const reportId = nanoid(8).toUpperCase(); 

        const newReport = {
            id: reportId, 
            title: problem_type, 
            description: description,
            location: location,
            institution: institution,
            status: 'New', 
            key_hash: keyHash, 
            approveVotes: 0,
            challengeVotes: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        await db.collection('reports').doc(reportId).set(newReport);
        console.log(`Report ${reportId} successfully submitted to Firebase.`);

        // Redirect with the user's key
        res.redirect(`/app.html?code=${userKey}`);

    } catch (error) {
        console.error("Error submitting report:", error);
        res.status(500).send("Error submitting report.");
    }
});

// 2. CHECK STATUS (Used by app.html)
app.get('/check-status', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: 'Database not connected.' });
    
    try {
        const { code } = req.query; // Query parameter from URL
        if (!code) {
            return res.status(400).json({ success: false, message: 'No code provided.' });
        }
        
        const keyHash = crypto.createHash('sha256').update(code).digest('hex');
        const reportsRef = db.collection('reports');
        const snapshot = await reportsRef.where('key_hash', '==', keyHash).limit(1).get();

        if (snapshot.empty) {
            return res.status(404).json({ success: false, message: 'No report found with this key.' });
        }

        const report = snapshot.docs[0].data();
        const submittedDate = report.createdAt ? report.createdAt.toDate().toLocaleString() : 'N/A';

        res.json({ 
            success: true, 
            report: { ...report, timestamp: submittedDate } 
        });

    } catch (error) {
         console.error("Error checking status:", error);
         res.status(500).json({ success: false, message: 'An error occurred.' });
    }
});

// 3. CONFIRM FIX (STEP 2)
app.post('/confirm-fix', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: 'Database not connected.' });

    try {
        const { reportId, userKey } = req.body;
        const reportRef = db.collection('reports').doc(reportId);
        const doc = await reportRef.get();

        if (!doc.exists) {
            return res.status(404).json({ message: "Report not found." });
        }

        const report = doc.data();
        const keyHash = crypto.createHash('sha256').update(userKey).digest('hex');

        // Check 1: Is the key valid?
        if (keyHash !== report.key_hash) {
            return res.status(403).json({ message: "Invalid key for this report." });
        }
        // Check 2: Is the report in the correct state?
        if (report.status !== 'Resolved') {
            return res.status(400).json({ message: "Report is not in a 'Resolved' state." });
        }

        // All checks passed! Move to "InReview" (Step 3)
        await reportRef.update({ status: 'InReview' });
        res.json({ success: true, message: "Report moved to 'InReview' queue." });

    } catch (error) {
        console.error("Error confirming fix:", error);
        res.status(500).json({ message: "An error occurred." });
    }
});

// 4. CAST VOTE (STEP 3) - NOW WITH "JUDGE"
app.post('/cast-vote', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: 'Database not connected.' });

    try {
        const { reportId, voteType } = req.body;
        const reportRef = db.collection('reports').doc(reportId);

        let updateData = {};
        if (voteType === 'approve') {
            updateData = { approveVotes: admin.firestore.FieldValue.increment(1) };
        } else if (voteType === 'challenge') {
            updateData = { challengeVotes: admin.firestore.FieldValue.increment(1) };
        } else {
            return res.status(400).json({ message: "Invalid vote type." });
        }

        await reportRef.update(updateData);
        
        // After the vote is counted, tell the server to "judge" this report.
        await judgeReport(reportId); 

        res.json({ success: true, message: "Vote counted." });

    } catch (error) {
        console.error("Error casting vote:", error);
        res.status(500).json({ message: "An error occurred." });
    }
});

// 5. CHECK GOLDEN KEY (STEP 5)
app.post('/check-golden-key', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: 'Database not connected.' });

    try {
        const { userKey } = req.body;
        const keyHash = crypto.createHash('sha256').update(userKey).digest('hex');
        
        // Check the 'goldenKeys' collection
        const keyRef = db.collection('goldenKeys').doc(keyHash);
        const doc = await keyRef.get();

        if (doc.exists) {
            res.json({ isGoldenKey: true });
        } else {
            res.json({ isGoldenKey: false });
        }
    } catch (error) {
        console.error("Error checking golden key:", error);
        res.status(500).json({ message: "An error occurred." });
    }
});

// 6. GOLDEN KEY ACTIONS (STEP 5)
async function goldenKeyAuth(req, res, next) {
    if (!db) return res.status(500).json({ success: false, message: 'Database not connected.' });

    // Middleware to protect routes for Golden Key holders
    try {
        const { userKey } = req.body;
        if (!userKey) {
            return res.status(401).json({ message: "No userKey provided." });
        }
        const keyHash = crypto.createHash('sha256').update(userKey).digest('hex');
        const keyRef = db.collection('goldenKeys').doc(keyHash);
        const doc = await keyRef.get();

        if (!doc.exists) {
            return res.status(403).json({ message: "Invalid or non-existent Golden Key." });
        }
        
        // Key is valid, proceed to the action (sponsor or veto)
        req.keyHash = keyHash; // Pass the hash to the next function
        next();

    } catch (error) {
        res.status(500).json({ message: "Authentication error." });
    }
}

app.post('/sponsor-report', goldenKeyAuth, async (req, res) => {
    try {
        const { reportId } = req.body;
        const reportRef = db.collection('reports').doc(reportId);
        
        // Update report status to "Vetted"
        await reportRef.update({ status: 'Vetted' });
        
        // Log this action to prevent abuse (Burn Rule)
        await db.collection('goldenKeyActions').add({
            keyHash: req.keyHash,
            action: 'sponsor',
            reportId: reportId,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true, message: "Report sponsored!" });

    } catch (error) {
        console.error("Error sponsoring report:", error);
        res.status(500).json({ message: "An error occurred." });
    }
});

app.post('/veto-report', goldenKeyAuth, async (req, res) => {
    try {
        const { reportId } = req.body;
        const reportRef = db.collection('reports').doc(reportId);
        
        // Update report status to "Junk"
        await reportRef.update({ status: 'Junk' });

        // Log this action
        await db.collection('goldenKeyActions').add({
            keyHash: req.keyHash,
            action: 'veto',
            reportId: reportId,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        res.json({ success: true, message: "Report vetoed as Junk." });

    } catch (error) {
        console.error("Error vetoing report:", error);
        res.status(500).json({ message: "An error occurred." });
    }
});


// 7. GET ALL REPORTS (for Dashboard)
app.get('/get-all-reports', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: 'Database not connected.' });

    try {
        const reportsRef = db.collection('reports');
        // Filter out "Junk" reports from the public view
        const snapshot = await reportsRef.where('status', '!=', 'Junk').get();

        if (snapshot.empty) {
            return res.json([]);
        }

        let reports = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            
            // --- FIX IS HERE: Robust check for createdAt ---
            let reportTimestamp;
            if (data.createdAt && typeof data.createdAt.toDate === 'function') {
                reportTimestamp = data.createdAt.toDate().toISOString();
            } else {
                // Handle old data submitted before the server timestamp was active
                reportTimestamp = new Date().toISOString(); 
            }
            // --- END FIX ---

            reports.push({
                ...data,
                timestamp: reportTimestamp
            });
        });
        
        // Sort by creation date, newest first
        reports.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        res.json(reports);

    } catch (error) {
        console.error("Error fetching all reports:", error);
        // Do NOT send the whole error message to the client, just a generic one
        res.status(500).json({ success: false, message: 'An internal server error occurred while fetching reports.' });
    }
});

// --- VERCEL EXPORT ---
module.exports = app;