// proxy-server.js
require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const axios = require('axios');
const multer = require('multer'); // <-- Import multer

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer(); // <-- Initialize multer

// --- API Targets ---
const PHPTRAVELS_TARGET = 'https://api.phptravels.com';
const DUFFEL_API_ENDPOINT = 'https://api.duffel.com/air/offer_requests';

// --- Middleware Setup ---
app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// =========================================================================
// THE FIX: Use multer to parse any multipart/form-data.
// This needs to run BEFORE our smartApiHandler. It will populate req.body.
// We use .any() because we just want to parse the fields, not save any files.
// =========================================================================
app.use(upload.any());


// The Smart Middleware (unchanged logic, but will now have a valid req.body)
const smartApiHandler = async (req, res, next) => {
    if (req.originalUrl.includes('/flights/duffel/')) {
        console.log('[ADAPTER] Intercepted Duffel request. Handling natively.');

        // This line should now work because multer has populated req.body
        const duffelApiKey = req.body.c1;

        if (!duffelApiKey) {
            console.error('[ADAPTER] Duffel API key not found in request body (expected `c1`).');
            console.log('[DEBUG] Full request body received:', req.body); // Log the body to see what we got
            return res.status(400).json({ error: 'Missing API credentials for Duffel module.' });
        }

        try {
            const duffelRequestPayload = mapPhpToDuffelRequest(req.body);
            const duffelResponse = await axios.post(DUFFEL_API_ENDPOINT, duffelRequestPayload, {
                headers: {
                    'Accept-Encoding': 'gzip',
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Duffel-Version': 'v1',
                    'Authorization': `Bearer ${duffelApiKey}`
                }
            });

            console.log('--- RAW DUFFEL API RESPONSE (START) ---');
            console.log(JSON.stringify(duffelResponse.data, null, 2));
            console.log('--- RAW DUFFEL API RESPONSE (END) ---');

            const phpAppResponse = mapDuffelToPhpResponse(duffelResponse.data, req.body);

            console.log('--- FINAL MAPPED RESPONSE to PHP (START) ---');
            console.log(JSON.stringify(phpAppResponse, null, 2));
            console.log('--- FINAL MAPPED RESPONSE to PHP (END) ---');

            return res.status(200).json(phpAppResponse);

        } catch (error) {
            const errorDetails = error.response ? error.response.data : error.message;
            console.error('[ADAPTER] Error during Duffel API call:', JSON.stringify(errorDetails, null, 2));
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


// MAPPING FUNCTIONS (with debugging logs from before)
function mapPhpToDuffelRequest(phpRequest) {
    const passengers = [];
    if (phpRequest.adults > 0) for (let i = 0; i < phpRequest.adults; i++) passengers.push({ type: 'adult' });
    if (phpRequest.childrens > 0) for (let i = 0; i < phpRequest.childrens; i++) passengers.push({ type: 'child' });
    if (phpRequest.infants > 0) for (let i = 0; i < phpRequest.infants; i++) passengers.push({ type: 'infant_without_seat' });
    const slices = [{ origin: phpRequest.origin, destination: phpRequest.destination, departure_date: phpRequest.departure_date }];
    if (phpRequest.triptypename === 'round' && phpRequest.return_date) {
        slices.push({ origin: phpRequest.destination, destination: phpRequest.origin, departure_date: phpRequest.return_date });
    }
    return { data: { slices, passengers, cabin_class: phpRequest.class_type } };
}

function mapDuffelToPhpResponse(duffelData, originalPhpRequest) {
    if (!duffelData.data || !duffelData.data.offers) return [];

    return duffelData.data.offers.map(offer => {
        return {
            segments: offer.slices.map(slice => {
                return slice.segments.map(segment => {
                    console.log(`\n--- MAPPING OFFER ID: ${offer.id}, SEGMENT ID: ${segment.id} ---`);
                    const firstPassengerBaggage = offer.passengers[0]?.baggages || [];
                    console.log('[DEBUG] Baggage array for passenger 0:', JSON.stringify(firstPassengerBaggage));
                    const checkedBaggage = firstPassengerBaggage.find(b => b.type === 'checked');
                    const carryOnBaggage = firstPassengerBaggage.find(b => b.type === 'carry_on');
                    console.log('[DEBUG] Found checked baggage object:', checkedBaggage);
                    console.log('[DEBUG] Found carry-on baggage object:', carryOnBaggage);
                    const baggageString = checkedBaggage ? `${checkedBaggage.quantity} piece(s)` : 'No checked bag';
                    const cabinBaggageString = carryOnBaggage ? `${carryOnBaggage.quantity} piece(s)` : 'No carry-on';
                    console.log(`[DEBUG] Final Baggage String: "${baggageString}"`);
                    console.log(`[DEBUG] Final Cabin Baggage String: "${cabinBaggageString}"`);
                    console.log('--- END MAPPING ---');
                    const duration = segment.duration.replace('PT', '').replace('H', 'h ').replace('M', 'm').toLowerCase();
                    return {
                        baggage: baggageString,
                        cabin_baggage: cabinBaggageString,
                        img: segment.operating_carrier.logo_symbol_url || '',
                        flight_no: segment.operating_carrier_flight_number,
                        airline: segment.operating_carrier.name,
                        class: offer.cabin_class,
                        departure_airport: segment.origin.name,
                        departure_time: segment.departing_at.substring(11, 16),
                        departure_date: segment.departing_at.substring(0, 10),
                        departure_code: segment.origin.iata_code,
                        arrival_airport: segment.destination.name,
                        arrival_date: segment.arriving_at.substring(0, 10),
                        arrival_time: segment.arriving_at.substring(11, 16),
                        arrival_code: segment.destination.iata_code,
                        duration_time: duration,
                        total_duration: offer.total_duration.replace('PT', '').replace('H', 'h ').replace('M', 'm').toLowerCase(),
                        currency: originalPhpRequest.currency,
                        actual_currency: offer.total_currency,
                        price: offer.total_amount,
                        actual_price: offer.total_amount,
                        adult_price: offer.total_amount,
                        child_price: "0",
                        infant_price: "0",
                        booking_data: { offer_id: offer.id },
                        supplier: "duffel",
                        type: originalPhpRequest.triptypename,
                        refundable: !offer.payment_requirements.requires_instant_payment,
                    };
                });
            })
        };
    });
}

// Start server
app.listen(PORT, () => {
    console.log(`Node.js API Adapter/Proxy running at http://localhost:${PORT}`);
});
