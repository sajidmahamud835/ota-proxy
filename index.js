// proxy-server.js
require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const axios = require('axios'); // For making direct API calls

const app = express();
const PORT = process.env.PORT || 3000;

// --- API Targets ---
const PHPTRAVELS_TARGET = 'https://api.phptravels.com'; // Fallback for other modules
const DUFFEL_API_ENDPOINT = 'https://api.duffel.com/air/offer_requests'; // The real Duffel API

// --- Middleware Setup ---
app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// =========================================================================
// The Smart Middleware: Intercepts and routes based on URL
// This runs for ALL requests starting with '/api'
// =========================================================================
const smartApiHandler = async (req, res, next) => {
    // Check if this request is for the 'duffel' module
    if (req.originalUrl.includes('/flights/duffel/')) {
        console.log('[ADAPTER] Intercepted a request for the Duffel module. Handling natively.');

        // Extract the Duffel API Key from the request body (sent as 'c1' by PHP)
        const duffelApiKey = req.body.c1;
        if (!duffelApiKey) {
            console.error('[ADAPTER] Duffel API key not found in request body (expected in `c1`).');
            return res.status(400).json({ error: 'Missing API credentials for Duffel module.' });
        }

        try {
            // 1. Map the request from PHP format to Duffel format
            const duffelRequestPayload = mapPhpToDuffelRequest(req.body);

            // 2. Call the real Duffel API with the extracted key
            const duffelResponse = await axios.post(DUFFEL_API_ENDPOINT, duffelRequestPayload, {
                headers: {
                    'Accept-Encoding': 'gzip',
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Duffel-Version': 'v1',
                    'Authorization': `Bearer ${duffelApiKey}`
                }
            });

            // 3. Map the rich Duffel response back to the standard PHP format
            const phpAppResponse = mapDuffelToPhpResponse(duffelResponse.data, req.body);

            console.log('[ADAPTER] Successfully processed Duffel response. Sending to client.');
            // Send the response and STOP further processing (do not call next())
            return res.status(200).json(phpAppResponse);

        } catch (error) {
            const errorDetails = error.response ? error.response.data : error.message;
            console.error('[ADAPTER] Error during Duffel API call:', JSON.stringify(errorDetails, null, 2));
            // Return an empty array so the PHP app's search doesn't break
            return res.status(500).json([]);
        }
    }

    // If we're here, it's NOT a Duffel request. Pass control to the next middleware (the proxy).
    console.log(`[PROXY] Passing request for '${req.originalUrl}' to phptravels.com.`);
    next();
};

// =========================================================================
// Registering the Middleware and Proxy
// =========================================================================

// 1. First, register our smart handler for all '/api' routes
app.use('/api', smartApiHandler);

// 2. Then, register the generic proxy. This will only be reached if smartApiHandler calls next().
app.use('/api', createProxyMiddleware({
    target: PHPTRAVELS_TARGET,
    changeOrigin: true,
    pathRewrite: {
        '^/api': '', // Remove /api prefix for phptravels.com
    },
}));

// =========================================================================
// Mapping Functions (Helper logic for the adapter)
// =========================================================================

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
                    const firstPassengerBaggage = offer.passengers[0].baggages || [];
                    const checkedBaggage = firstPassengerBaggage.find(b => b.type === 'checked');
                    const carryOnBaggage = firstPassengerBaggage.find(b => b.type === 'carry_on');
                    const duration = segment.duration.replace('PT', '').replace('H', 'h ').replace('M', 'm').toLowerCase();

                    return {
                        img: segment.operating_carrier.logo_symbol_url || '',
                        flight_no: segment.operating_carrier_flight_number,
                        airline: segment.operating_carrier.name,
                        class: offer.cabin_class,
                        baggage: checkedBaggage ? `${checkedBaggage.quantity} piece(s)` : 'No checked bag',
                        cabin_baggage: carryOnBaggage ? `${carryOnBaggage.quantity} piece(s)` : 'No carry-on',
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
