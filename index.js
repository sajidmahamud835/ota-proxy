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
const PHPTRAVELS_TARGET = 'https://api.phptravels.com'; // Fallback for all other modules
const IATA_LOCAL_TARGET = 'http://ota-node-server-2-1.onrender.com/api'; // New native target

// --- Middleware Setup ---
app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(upload.any()); // Use multer to handle form-data from PHP cURL

// =========================================================================
// The Smart Middleware: Intercepts and routes based on URL
// =========================================================================
const smartApiHandler = async (req, res, next) => {
    // --- THE FIX: Convert URL to lowercase for a robust, case-insensitive check ---
    if (req.originalUrl.toLowerCase().includes('/flights/iatalocal/')) {
        console.log('[ADAPTER] Intercepted a request for the iatalocal module. Handling natively.');

        try {
            // 1. Map the request from PHP format to iatalocal format
            const iataLocalRequestPayload = mapPhpToIataLocalRequest(req.body);
            console.log('[ADAPTER] Mapped request to iatalocal format:', JSON.stringify(iataLocalRequestPayload, null, 2));

            // 2. Call the real iatalocal API
            const iataLocalResponse = await axios.post(IATA_LOCAL_TARGET, iataLocalRequestPayload, {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                }
            });

            // 3. Map the complex iatalocal response back to the standard PHP format
            const phpAppResponse = mapIataLocalToPhpResponse(iataLocalResponse.data);
            console.log('[ADAPTER] Successfully processed and mapped iatalocal response.');

            return res.status(200).json(phpAppResponse);

        } catch (error) {
            const errorDetails = error.response ? error.response.data : error.message;
            console.error('[ADAPTER] Error during iatalocal API call:', JSON.stringify(errorDetails, null, 2));
            return res.status(500).json([]); // Return empty array on error
        }
    }

    // If it's not an iatalocal request, pass it to the phptravels proxy
    console.log(`[PROXY] Passing request for '${req.originalUrl}' to phptravels.com.`);
    next();
};

// Register our smart handler first
app.use('/api', smartApiHandler);

// The generic proxy is the fallback if next() is called
app.use('/api', createProxyMiddleware({
    target: PHPTRAVELS_TARGET,
    changeOrigin: true,
    pathRewrite: { '^/api': '' },
}));


// =========================================================================
// MAPPING FUNCTIONS FOR IATA_LOCAL ADAPTER
// =========================================================================

function formatDateForIataLocal(dateString) {
    const date = new Date(dateString);
    const day = String(date.getDate()).padStart(2, '0');
    const month = date.toLocaleString('en-US', { month: 'short' });
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
}

function mapPhpToIataLocalRequest(phpRequest) {
    const fromCode = phpRequest.origin;
    const toCode = phpRequest.destination;

    return {
        is_combo: 0,
        CMND: "_FLIGHTSEARCH_",
        TRIP: phpRequest.triptypename === 'round' ? "RT" : "OW",
        FROM: fromCode,
        DEST: toCode,
        JDT: formatDateForIataLocal(phpRequest.departure_date),
        RDT: phpRequest.return_date ? formatDateForIataLocal(phpRequest.return_date) : "",
        ACLASS: "Y",
        AD: parseInt(phpRequest.adults, 10) || 0,
        CH: parseInt(phpRequest.childrens, 10) || 0,
        INF: parseInt(phpRequest.infants, 10) || 0,
        Umrah: "0",
    };
}

function mapIataLocalToPhpResponse(iataResponse) {
    if (!iataResponse.success || !iataResponse.data || !iataResponse.data.Trips) {
        return [];
    }

    const trips = iataResponse.data.Trips;
    const itineraries = new Map();

    trips.forEach(trip => {
        const key = trip.fSoft;
        if (!itineraries.has(key)) {
            itineraries.set(key, { segments: [[], []] });
        }

        const currentItinerary = itineraries.get(key);
        const legIndex = trip.fReturn ? 1 : 0;

        trip.fLegs.forEach(leg => {
            const phpSegment = {
                img: `https://daisycon.io/images/airline/?width=300&height=150&color=ffffff&iata=${leg.xACode}`,
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
                duration_time: trip.fDur,
                total_duration: trip.fDur,
                currency: "BDT",
                actual_currency: "BDT",
                price: trip.fFare.toString(),
                actual_price: trip.fFare.toString(),
                adult_price: trip.fFare.toString(),
                child_price: "0",
                infant_price: "0",
                booking_data: { fSoft: trip.fSoft, fGDSid: trip.fGDSid },
                supplier: "iatalocal",
                type: trip.fReturn ? "round" : "oneway",
                refundable: trip.fRefund !== "NONREFUND",
            };
            currentItinerary.segments[legIndex].push(phpSegment);
        });
    });

    // For one-way trips, the second leg (index 1) will be empty. We must filter those out.
    // We also need to filter out round-trip itineraries where one of the legs is missing.
    const validItineraries = Array.from(itineraries.values()).filter(itinerary => {
        const isRoundTrip = itinerary.segments[1].length > 0;
        if (isRoundTrip) {
            // For a round trip, both legs must have segments
            return itinerary.segments[0].length > 0 && itinerary.segments[1].length > 0;
        } else {
            // For a one-way, only the first leg must have segments
            return itinerary.segments[0].length > 0;
        }
    });

    return validItineraries;
}

// Start server
app.listen(PORT, () => {
    console.log(`Node.js API Adapter/Proxy running at http://localhost:${PORT}`);
});
