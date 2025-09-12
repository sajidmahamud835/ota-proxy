// proxy-server.js
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
const IATA_LOCAL_TARGET = 'http://ota-node-server-2-1.onrender.com/api';

// --- Middleware Setup ---
app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(upload.any());

// =========================================================================
// The Smart Middleware
// =========================================================================
const smartApiHandler = async (req, res, next) => {
    if (req.originalUrl.toLowerCase().includes('/flights/iatalocal/')) {
        console.log('[ADAPTER] Intercepted iatalocal request. Handling natively.');
        try {
            const iataLocalRequestPayload = mapPhpToIataLocalRequest(req.body);
            console.log('[ADAPTER] Mapped request to iatalocal format:', JSON.stringify(iataLocalRequestPayload, null, 2));

            const iataLocalResponse = await axios.post(IATA_LOCAL_TARGET, iataLocalRequestPayload, {
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
            });

            const phpAppResponse = mapIataLocalToPhpResponse(iataLocalResponse.data, req.body.triptypename);
            console.log('[ADAPTER] Successfully processed and mapped iatalocal response.');
            return res.status(200).json(phpAppResponse);
        } catch (error) {
            const errorDetails = error.response ? error.response.data : error.message;
            console.error('[ADAPTER] Error during iatalocal API call:', JSON.stringify(errorDetails, null, 2));
            return res.status(500).json([]);
        }
    }
    console.log(`[PROXY] Passing request for '${req.originalUrl}' to phptravels.com.`);
    next();
};

app.use('/api', smartApiHandler);

app.use('/api', createProxyMiddleware({
    target: PHPTRAVELS_TARGET,
    changeOrigin: true,
    pathRewrite: { '^/api': '' },
}));


// =========================================================================
// MAPPING FUNCTIONS FOR IATA_LOCAL ADAPTER
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


/**
 * Converts total minutes into HH:MM format.
 * @param {number} totalMinutes - The total duration in minutes (from fDursec).
 * @returns {string} The formatted duration string, e.g., "12:01".
 */
function formatDuration(totalMinutes) {
    if (isNaN(totalMinutes)) return "00:00";
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    const paddedHours = String(hours).padStart(2, '0');
    const paddedMinutes = String(minutes).padStart(2, '0');
    return `${paddedHours}:${paddedMinutes}`;
}


/**
 * Maps an individual trip object from iatalocal to a segment array for PHP.
 */
function createPhpSegments(trip) {
    // FIX 2: Calculate the duration in HH:MM format from fDursec
    const formattedDuration = formatDuration(trip.fDursec);

    return trip.fLegs.map(leg => ({
        // FIX 1: Use the correct Duffel logo URL format with the main airline code
        img: `https://assets.duffel.com/img/airlines/for-light-background/full-color-logo/v1/350x150/${trip.stAirCode}.svg`,
        flight_no: leg.xFlight,
        airline: trip.stAirline,
        class: leg.xClass,
        baggage: trip.fBag.replace('Baggage:', '').trim(),
        cabin_baggage: "N/A",
        departure_airport: leg.xFrom,
        departure_time: leg.DTime.substring(11, 16),
        departure_date: leg.DTime.substring(0, 10),
        departure_code: leg.xFrom,
        arrival_airport: leg.xDest,
        arrival_date: leg.ATime.substring(0, 10),
        arrival_time: leg.ATime.substring(11, 16),
        arrival_code: leg.xDest,
        duration_time: formattedDuration, // Use the formatted duration
        total_duration: formattedDuration, // Use the same formatted duration
        currency: "BDT",
        actual_currency: "BDT",
        price: trip.fFare.toString(),
        actual_price: trip.fFare.toString(),
        adult_price: trip.fFare.toString(),
        child_price: "0",
        infant_price: "0",
        booking_data: { fSoft: trip.fSoft, fGDSid: trip.fGDSid, fAMYid: trip.fAMYid },
        supplier: "iatalocal",
        type: trip.fReturn ? "round" : "oneway",
        refundable: trip.fRefund !== "NONREFUND",
        redirect_url: "",
        color: "#0d3981",
    }));
}


function mapIataLocalToPhpResponse(iataResponse, tripType) {
    if (!iataResponse.success || !iataResponse.data || !iataResponse.data.Trips) {
        return [];
    }

    const trips = iataResponse.data.Trips;

    if (tripType === 'oneway') {
        return trips.map(trip => ({
            segments: [createPhpSegments(trip)]
        }));
    }

    const outboundFlights = new Map();
    const inboundFlights = new Map();

    trips.forEach(trip => {
        const key = `${trip.fSoft}-${trip.fGDSid}`;
        if (trip.fReturn) {
            inboundFlights.set(key, trip);
        } else {
            outboundFlights.set(key, trip);
        }
    });

    const finalItineraries = [];

    outboundFlights.forEach((outboundTrip, key) => {
        if (inboundFlights.has(key)) {
            const inboundTrip = inboundFlights.get(key);
            const outboundSegments = createPhpSegments(outboundTrip);
            const inboundSegments = createPhpSegments(inboundTrip);

            finalItineraries.push({
                segments: [outboundSegments, inboundSegments]
            });
        }
    });

    return finalItineraries;
}


// Start server
app.listen(PORT, () => {
    console.log(`Node.js API Adapter/Proxy running at http://localhost:${PORT}`);
});
