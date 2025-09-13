// proxy-server.js
require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// --- API Targets ---
const PHPTRAVELS_TARGET = 'https://api.phptravels.com';
const IATA_LOCAL_BASE_URL = 'http://ota-node-server-2-1.onrender.com';
const IATA_LOCAL_API_TARGET = `${IATA_LOCAL_BASE_URL}/api`;

// --- Logging middleware ---
app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use((req, res, next) => {
    console.log('--- Incoming Request ---');
    console.log(`${req.method} ${req.originalUrl}`);
    console.log('Query:', req.query);
    if (req.body && Object.keys(req.body).length) {
        console.log('Body:', req.body);
    }
    const originalSend = res.send.bind(res);
    res.send = (body) => {
        console.log('--- Outgoing Response ---');
        console.log('Status:', res.statusCode);
        console.log('Body:', body);
        return originalSend(body);
    };
    next();
});

// =========================================================================
// IATA Local Adapter Route
// =========================================================================
app.post('/api/flights/iatalocal', async (req, res) => {
    console.log('[ADAPTER] Intercepted iatalocal request.');

    try {
        const iataLocalRequestPayload = mapPhpToIataLocalRequest(req.body);
        console.log('[ADAPTER] Mapped request:', JSON.stringify(iataLocalRequestPayload, null, 2));

        const iataLocalResponse = await axios.post(IATA_LOCAL_API_TARGET, iataLocalRequestPayload, {
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
        });

        const phpAppResponse = mapIataLocalToPhpResponse(iataLocalResponse.data, req.body.triptypename);
        return res.status(200).json(phpAppResponse);
    } catch (error) {
        const errorDetails = error.response ? error.response.data : error.message;
        console.error('[ADAPTER] Error during iatalocal API call:', JSON.stringify(errorDetails, null, 2));
        return res.status(500).json([]);
    }
});

// =========================================================================
// RAW Proxy for all other PHPTravels APIs (Duffel, Amy, etc.)
// =========================================================================
app.use(
    '/api',
    express.raw({ type: '*/*' }),
    createProxyMiddleware({
        target: PHPTRAVELS_TARGET,
        changeOrigin: true,
        pathRewrite: { '^/api': '' },
        onProxyReq: (proxyReq, req) => {
            if (req.body && req.body.length) {
                proxyReq.setHeader('Content-Length', req.body.length);
                proxyReq.write(req.body); // write raw buffer
            }
        },
        onProxyRes: (proxyRes, req, res) => {
            let body = [];
            proxyRes.on('data', (chunk) => body.push(chunk));
            proxyRes.on('end', () => {
                body = Buffer.concat(body).toString();
                console.log('--- Proxy Response ---');
                console.log('Status:', proxyRes.statusCode);
                console.log('Body:', body);
            });
        }
    })
);

// =========================================================================
// IATA Local Mapping Functions
// =========================================================================
function convertDateToDDMonYYYY(yyyyMmDd) {
    if (!yyyyMmDd || typeof yyyyMmDd !== 'string') return "";
    const parts = yyyyMmDd.split('-');
    if (parts.length !== 3) return "";
    const [year, month, day] = parts;
    const monthIndex = parseInt(month, 10) - 1;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    if (monthIndex < 0 || monthIndex > 11) return "";
    return `${day}-${months[monthIndex]}-${year}`;
}

function mapPhpToIataLocalRequest(phpRequest) {
    const fromCode = (phpRequest.origin.split(' - ')[1] || phpRequest.origin).trim();
    const toCode = (phpRequest.destination.split(' - ')[1] || phpRequest.destination).trim();

    return {
        is_combo: 0,
        CMND: "_FLIGHTSEARCH_",
        TRIP: phpRequest.triptypename === 'round' ? "RT" : "OW",
        FROM: fromCode,
        DEST: toCode,
        JDT: convertDateToDDMonYYYY(phpRequest.departure_date),
        RDT: phpRequest.return_date ? convertDateToDDMonYYYY(phpRequest.return_date) : "",
        ACLASS: "Y",
        AD: parseInt(phpRequest.adults, 10) || 0,
        CH: parseInt(phpRequest.childrens, 10) || 0,
        INF: parseInt(phpRequest.infants, 10) || 0,
        Umrah: "0",
    };
}

function formatDuration(totalMinutes) {
    if (isNaN(totalMinutes)) return "00:00";
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function createPhpSegments(trip) {
    const formattedDuration = formatDuration(trip.fDursec);

    return trip.fLegs.map(leg => ({
        img: trip.stAirCode,
        flight_no: leg.xFlight,
        airline: trip.stAirline,
        class: leg.xClass,
        baggage: trip.fBag.replace('Baggage:', '').trim(),
        cabin_baggage: "7 Kg",
        departure_airport: leg.xFrom,
        departure_time: leg.DTime.substring(11, 16),
        departure_date: leg.DTime.substring(0, 10),
        departure_code: leg.xFrom,
        arrival_airport: leg.xDest,
        arrival_date: leg.ATime.substring(0, 10),
        arrival_time: leg.ATime.substring(11, 16),
        arrival_code: leg.xDest,
        duration_time: formattedDuration,
        total_duration: formattedDuration,
        currency: "BDT",
        actual_currency: "BDT",
        price: trip.fFare.toString(),
        actual_price: (trip.fFare || 0).toString(),
        adult_price: trip.fFare.toString(),
        child_price: trip.fFare.toString(),
        infant_price: trip.fFare.toString(),
        booking_data: {
            booking_id: trip.fAMYid,
            fSoft: trip.fSoft,
            fGDSid: trip.fGDSid,
            transit1: trip.fTransit1 || "",
            transit2: trip.fTransit2 || "",
            transit_ap1: trip.fTransitAP1 || "",
            transit_ap2: trip.fTransitAP2 || "",
            aircraft_model: trip.fModel || "",
            source: trip.csource || "GDS",
        },
        supplier: "iatalocal",
        type: trip.fReturn ? "round" : "oneway",
        refundable: trip.fRefund !== "NONREFUND",
        redirect_url: "",
        color: "#0d3981",
    }));
}

function mapIataLocalToPhpResponse(iataResponse, tripType) {
    if (!iataResponse.success || !iataResponse.data || !iataResponse.data.Trips) return [];

    const trips = iataResponse.data.Trips;
    if (tripType === 'oneway') {
        return trips.map(trip => ({ segments: [createPhpSegments(trip)] }));
    }

    const outboundFlights = new Map();
    const inboundFlights = new Map();

    trips.forEach(trip => {
        const key = `${trip.fSoft}-${trip.fGDSid}`;
        if (trip.fReturn) inboundFlights.set(key, trip);
        else outboundFlights.set(key, trip);
    });

    const finalItineraries = [];
    outboundFlights.forEach((outboundTrip, key) => {
        if (inboundFlights.has(key)) {
            const inboundTrip = inboundFlights.get(key);
            const outboundSegments = createPhpSegments(outboundTrip);
            const inboundSegments = createPhpSegments(inboundTrip);
            finalItineraries.push({ segments: [outboundSegments, inboundSegments] });
        }
    });

    return finalItineraries;
}

// --- Root ---
app.get("/", (req, res) => {
    res.send("Welcome to the OTA Proxy Server.");
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`OTA Proxy running at http://localhost:${PORT}`);
});
