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
const IATA_LOCAL_BASE_URL = 'http://ota-node-server-2-1.onrender.com';
const IATA_LOCAL_API_TARGET = `${IATA_LOCAL_BASE_URL}/api`;

// --- Middleware Setup ---
app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(upload.any());

// =========================================================================
// Status Route
// =========================================================================
app.get('/status', async (req, res) => {
    const startTime = Date.now();
    try {
        const pingResponse = await axios.get(`${IATA_LOCAL_BASE_URL}/ping`);
        const latency = Date.now() - startTime;
        res.status(200).json({ service: 'iatalocal', status: 'ok', timestamp: new Date().toISOString(), latency: `${latency}ms`, response: pingResponse.data });
    } catch (error) {
        const latency = Date.now() - startTime;
        console.error('[STATUS] Error pinging iatalocal server:', error.message);
        res.status(503).json({ service: 'iatalocal', status: 'error', timestamp: new Date().toISOString(), latency: `${latency}ms`, error: error.message });
    }
});

// =========================================================================
// The Smart API Middleware
// =========================================================================
const smartApiHandler = async (req, res, next) => {
    if (req.originalUrl.toLowerCase().includes('/flights/iatalocal/')) {
        console.log('[ADAPTER] Intercepted iatalocal request. Handling natively.');
        try {
            const iataLocalRequestPayload = mapPhpToIataLocalRequest(req.body);
            const iataLocalResponse = await axios.post(IATA_LOCAL_API_TARGET, iataLocalRequestPayload, {
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
            });
            const phpAppResponse = mapIataLocalToPhpResponse(iataLocalResponse.data, req.body);
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

// --- Helper Functions ---

function convertDateToDDMonYYYY(yyyyMmDd) {
    if (!yyyyMmDd || typeof yyyyMmDd !== 'string' || yyyyMmDd.split('-').length !== 3) return "";
    const [year, month, day] = yyyyMmDd.split('-');
    const monthIndex = parseInt(month, 10) - 1;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    if (isNaN(monthIndex) || monthIndex < 0 || monthIndex > 11) return "";
    return `${day}-${months[monthIndex]}-${year}`;
}

function formatDuration(totalMinutes) {
    if (isNaN(totalMinutes) || totalMinutes < 0) return "00:00";
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// --- Request Mapping ---

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


// --- Response Mapping ---

/**
 * Creates a fully normalized, clean segment array from a raw `iatalocal` trip object.
 */
function createPhpSegments(trip, originalPhpRequest) {
    const totalFare = parseFloat(trip.fFare) || 0;
    const baseFare = parseFloat(trip.fBFare) || 0;

    // Create shared data that is the same for all segments in this leg
    const sharedData = {
        airline: trip.stAirline,
        pax_breakdown: {
            adult: parseInt(originalPhpRequest.adults, 10),
            child: parseInt(originalPhpRequest.childrens, 10),
            infant: parseInt(originalPhpRequest.infants, 10),
            total_passengers: (parseInt(originalPhpRequest.adults, 10) + parseInt(originalPhpRequest.childrens, 10) + parseInt(originalPhpRequest.infants, 10))
        },
        taxes: {
            base_fare: baseFare.toFixed(2),
            tax: (totalFare - baseFare).toFixed(2),
            total_fare: totalFare.toFixed(2),
        },
        fare_rules: {
            refundable: trip.fRefund !== "NONREFUND",
            penalty_details: "" // Placeholder
        },
        total_duration: formatDuration(trip.fDursec),
        supplier: "iatalocal",
        type: trip.fReturn ? "round" : "oneway",
        redirect_url: "",
        color: "#FF5733"
    };

    // Calculate stop details
    const stopDetails = {
        stop_count: trip.fLegs.length - 1,
        layovers: []
    };

    if (stopDetails.stop_count > 0) {
        for (let i = 0; i < trip.fLegs.length - 1; i++) {
            const currentLeg = trip.fLegs[i];
            const nextLeg = trip.fLegs[i + 1];
            const layoverStart = new Date(currentLeg.ATime);
            const layoverEnd = new Date(nextLeg.DTime);
            const layoverMinutes = (layoverEnd - layoverStart) / (1000 * 60);
            stopDetails.layovers.push({
                duration: formatDuration(layoverMinutes),
                airport: currentLeg.xDest
            });
        }
    }

    // Create each individual segment and enrich it with shared data
    return trip.fLegs.map(leg => {
        const departure = new Date(leg.DTime);
        const arrival = new Date(leg.ATime);
        const segmentDurationMinutes = (arrival - departure) / (1000 * 60);

        return {
            ...sharedData, // Spread all the shared data
            stop_details: stopDetails,
            img: trip.stAirCode,
            flight_no: leg.xFlight,
            class: trip.fClsNam || 'N/A',
            booking_class_code: trip.fClsNam || 'N/A',
            baggage: (trip.fBag || "N/A").replace('Baggage:', '').replace(/\s/g, '').toUpperCase(), // Standardized
            cabin_baggage: "7KG", // Standardized default
            aircraft_model: trip.fModel || "N/A",
            departure_airport: leg.xFrom,
            departure_time: leg.DTime.substring(11, 16),
            departure_date: leg.DTime.substring(0, 10),
            departure_code: leg.xFrom,
            arrival_airport: leg.xDest,
            arrival_date: leg.ATime.substring(0, 10),
            arrival_time: leg.ATime.substring(11, 16),
            arrival_code: leg.xDest,
            duration_time: formatDuration(segmentDurationMinutes), // Recalculated per segment
            booking_data: {
                booking_id: trip.fAMYid || trip.fGDSid, // Use fAMYid as primary
                gds_booking_id: trip.fGDSid,
                fare_source_key: trip.fSoft,
            },
        };
    });
}

function mapIataLocalToPhpResponse(iataResponse, originalPhpRequest) {
    if (!iataResponse.success || !iataResponse.data || !iataResponse.data.Trips) return [];

    const trips = iataResponse.data.Trips;
    const tripType = originalPhpRequest.triptypename;

    if (tripType === 'oneway') {
        return trips.map(trip => ({
            segments: [createPhpSegments(trip, originalPhpRequest)]
        }));
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
            const outboundSegments = createPhpSegments(outboundTrip, originalPhpRequest);
            const inboundSegments = createPhpSegments(inboundTrip, originalPhpRequest);
            finalItineraries.push({ segments: [outboundSegments, inboundSegments] });
        }
    });

    return finalItineraries;
}


// Start server
app.listen(PORT, () => {
    console.log(`Node.js API Adapter/Proxy running at http://localhost:${PORT}`);
});
