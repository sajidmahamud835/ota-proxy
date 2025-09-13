require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const axios = require('axios');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer();

// --- API Targets ---
const PHPTRAVELS_TARGET = 'https://api.phptravels.com';
const IATA_LOCAL_BASE_URL = 'http://ota-node-server-2-1.onrender.com';
const IATA_LOCAL_API_TARGET = `${IATA_LOCAL_BASE_URL}/api`;

// --- Middleware Setup ---
app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(upload.any());

// =========================================================================
// NEW: Status Route for Health Checks
// =========================================================================
app.get('/status', async (req, res) => {
    const startTime = Date.now();
    try {
        const pingResponse = await axios.get(`${IATA_LOCAL_BASE_URL}/ping`);
        const latency = Date.now() - startTime;

        res.status(200).json({
            service: 'iatalocal',
            status: 'ok',
            timestamp: new Date().toISOString(),
            latency: `${latency}ms`,
            response: pingResponse.data,
        });
    } catch (error) {
        const latency = Date.now() - startTime;
        console.error('[STATUS] Error pinging iatalocal server:', error.message);
        res.status(503).json({
            service: 'iatalocal',
            status: 'error',
            timestamp: new Date().toISOString(),
            latency: `${latency}ms`,
            error: error.message,
        });
    }
});

// =========================================================================
// Smart Middleware for /api routes (iatalocal only)
// =========================================================================
const smartApiHandler = async (req, res, next) => {
    if (req.originalUrl.toLowerCase().includes('/flights/iatalocal/')) {
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
    }

    // Pass other requests (Duffel etc.) to proxy
    next();
};

app.use('/api', smartApiHandler);

// =========================================================================
// Proxy Middleware for PHPTravels (handles Duffel & others)
// =========================================================================
app.use('/api', createProxyMiddleware({
    target: PHPTRAVELS_TARGET,
    changeOrigin: true,
    pathRewrite: { '^/api': '' },
    onProxyReq: (proxyReq, req) => {
        // Re-inject body for POST requests
        if (req.body && Object.keys(req.body).length > 0) {
            const bodyData = JSON.stringify(req.body);
            proxyReq.setHeader('Content-Type', 'application/json');
            proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
            proxyReq.write(bodyData);
        }
    }
}));

// =========================================================================
// MAPPING FUNCTIONS FOR IATALOCAL
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

// =========================================================================
// Price Calculation with Discount & Fee
// =========================================================================
function calculatePrice(trip) {
    const basePrice = trip.fFare || 0;
    const fromCountry = trip.xFrom.split(' - ')[2] || "";
    const toCountry = trip.xDest.split(' - ')[2] || "";
    const isDomestic = fromCountry === toCountry;

    let discountedPrice = basePrice;

    if (isDomestic) {
        // Domestic: 3% discount + 100 BDT fee
        discountedPrice = basePrice * 0.97 + 100;
    } else {
        // International: 5% discount + max(1000 BDT, 2% of fare)
        const fee = Math.max(1000, basePrice * 0.02);
        discountedPrice = basePrice * 0.95 + fee;
    }

    return Math.round(discountedPrice);
}

function createPhpSegments(trip) {
    const formattedDuration = formatDuration(trip.fDursec);
    const finalPrice = calculatePrice(trip);

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
        price: finalPrice.toString(),
        actual_price: (trip.fBFare || trip.fFare || 0).toString(),
        adult_price: finalPrice.toString(),
        child_price: finalPrice.toString(),
        infant_price: finalPrice.toString(),
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

// =========================================================================
// Start server
// =========================================================================
app.listen(PORT, () => {
    console.log(`Node.js API Adapter/Proxy running at http://localhost:${PORT}`);
});
