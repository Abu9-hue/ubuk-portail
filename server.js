require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const DATA_DIR = process.env.VERCEL ? '/tmp' : __dirname;
const DB_FILE = path.join(DATA_DIR, 'ledger_audit.json');
const AUDIO_DIR = path.join(DATA_DIR, 'vocaux');

if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ transactions: [], releves_blocs: [] }, null, 2));
}

function readDB() {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// 1. INITIALISATION PAIEMENT / DON / SCOLARITÉ (CINETPAY)
app.post('/api/pay/init', async (req, res) => {
    try {
        const { montant, motif, beneficiaire, bloc, telephone, nom_payeur } = req.body;
        const amountInt = Math.ceil(Number(montant) / 5) * 5;

        if (!amountInt || amountInt < 100) {
            return res.status(400).json({ error: 'Montant invalide (minimum 100 FCFA).' });
        }

        const transactionId = `UBUK-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
        const tauxComm = parseFloat(process.env.TAUX_COMMISSION_PLATEFORME || '0.02');
        const partCommission = Math.round(amountInt * tauxComm);
        const partSequestre = amountInt - partCommission;

        const db = readDB();
        db.transactions.unshift({
            transaction_id: transactionId,
            date: new Date().toISOString(),
            statut: 'EN_ATTENTE',
            montant_total: amountInt,
            devise: 'XAF',
            repartition_advans: {
                compte_sequestre_tiers: partSequestre,
                compte_fonctionnement_CA_102_002872: partCommission
            },
            motif: motif || 'Paiement solidaire / Scolarité',
            beneficiaire: beneficiaire || 'Fonds Communautaire',
            bloc: bloc || 'Douala',
            payeur: { nom: nom_payeur || 'Citoyen', telephone: telephone || '' }
        });
        writeDB(db);

        const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;
        const payload = {
            apikey: process.env.CINETPAY_API_KEY,
            site_id: process.env.CINETPAY_SITE_ID,
            transaction_id: transactionId,
            amount: amountInt,
            currency: 'XAF',
            description: `${motif || 'Solidarite'} - ${beneficiaire || 'UBUK'} (${bloc || 'Douala'})`,
            notify_url: `${baseUrl}/api/pay/webhook`,
            return_url: `${baseUrl}/ubuk-pay.html?tx=${transactionId}`,
            channels: 'ALL',
            customer_name: nom_payeur || 'Usager',
            customer_surname: 'UBUK',
            customer_phone_number: telephone || '697015643',
            customer_email: 'contact@ubuk.net',
            customer_address: bloc || 'Douala',
            customer_city: 'Douala',
            customer_country: 'CM',
            customer_state: 'LT',
            customer_zip_code: '00237'
        };

        const response = await axios.post('https://cinetpay.com', payload);

        if (response.data && response.data.code === '201') {
            return res.json({
                success: true,
                transaction_id: transactionId,
                payment_url: response.data.data.payment_url,
                repartition: { sequestre: partSequestre, fonctionnement: partCommission }
            });
        } else {
            return res.status(400).json({ error: 'Erreur CinetPay', details: response.data });
        }
    } catch (err) {
        console.error('Erreur Init Paiement:', err.response?.data || err.message);
        res.status(500).json({ error: 'Erreur serveur lors de l’initialisation du paiement.' });
    }
});

// 2. WEBHOOK IPN CINETPAY (CONFIRMATION & REÇU SHA-256)
app.post('/api/pay/webhook', async (req, res) => {
    try {
        const { cpm_trans_id, cpm_site_id } = req.body;
        if (!cpm_trans_id || cpm_site_id !== process.env.CINETPAY_SITE_ID) {
            return res.status(400).send('Requête invalide');
        }

        const verifyRes = await axios.post('https://cinetpay.com/check', {
            apikey: process.env.CINETPAY_API_KEY,
            site_id: process.env.CINETPAY_SITE_ID,
            transaction_id: cpm_trans_id
        });

        const db = readDB();
        const tx = db.transactions.find(t => t.transaction_id === cpm_trans_id);

        if (tx && verifyRes.data && verifyRes.data.code === '00') {
            tx.statut = 'VALIDE_CANTONNE';
            tx.date_validation = new Date().toISOString();
            tx.operateur = verifyRes.data.data.payment_method;
            tx.empreinte_recu = crypto
                .createHash('sha256')
                .update(`${tx.transaction_id}|${tx.montant_total}|${tx.date_validation}`)
                .digest('hex')
                .substring(0, 16)
                .toUpperCase();
            writeDB(db);
        }
        res.status(200).send('OK');
    } catch (err) {
        console.error('Erreur Webhook:', err.message);
        res.status(500).send('Erreur Webhook');
    }
});

// 3. RÉCEPTION DES NOTES VOCALES TERRAIN (LATIF VOICE)
app.post('/api/voice/note', express.raw({ type: 'audio/*', limit: '2mb' }), (req, res) => {
    const bloc = req.headers['x-bloc'] || 'Douala';
    const tel = req.headers['x-tel'] || 'Anonyme';
    const filename = `VOCAL-${Date.now()}.webm`;
    fs.writeFileSync(path.join(AUDIO_DIR, filename), req.body);

    const db = readDB();
    db.releves_blocs.unshift({
        id: filename,
        date: new Date().toISOString(),
        bloc,
        besoin_prioritaire: `Note vocale reçue (${tel})`,
        agent: 'Latif Voice'
    });
    writeDB(db);
    res.json({ success: true, id: filename });
});

// 4. BAROMÈTRE TERRAIN DES BLOCS (VÉCU CITOYEN)
app.post('/api/terrain/releve', (req, res) => {
    const { bloc, prix_riz_kg, heures_coupure_elec, besoin_prioritaire, agent } = req.body;
    const db = readDB();
    const releve = {
        id: `BLOC-${Date.now()}`,
        date: new Date().toISOString(),
        bloc: bloc || 'Douala',
        prix_riz_kg: Number(prix_riz_kg) || 0,
        heures_coupure_elec: Number(heures_coupure_elec) || 0,
        besoin_prioritaire: besoin_prioritaire || '',
        agent: agent || 'FIFEN Issah'
    };
    db.releves_blocs.unshift(releve);
    writeDB(db);
    res.json({ success: true, releve });
});

// 5. AUDIT DE TRANSPARENCE
app.get('/api/audit', (req, res) => {
    const db = readDB();
    let totalSequestre = 0;
    let totalFonctionnement = 0;

    db.transactions.forEach(t => {
        if (t.statut === 'VALIDE_CANTONNE' || t.statut === 'EN_ATTENTE') {
            totalSequestre += t.repartition_advans.compte_sequestre_tiers;
            totalFonctionnement += t.repartition_advans.compte_fonctionnement_CA_102_002872;
        }
    });

    res.json({
        totaux: {
            sequestre_tiers_xaf: totalSequestre,
            fonctionnement_xaf: totalFonctionnement,
            nb_transactions: db.transactions.length
        },
        transactions: db.transactions.slice(0, 20),
        releves_blocs: db.releves_blocs.slice(0, 10)
    });
});

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`✅ UBUK PAY / Latif Connect actif sur le port ${PORT}`));
}

module.exports = app;
          
