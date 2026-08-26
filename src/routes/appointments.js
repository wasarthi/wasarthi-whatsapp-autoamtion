/**
 * routes/appointments.js — weekly availability config, slot lookup, and
 * appointment CRUD for the dashboard.
 *
 * The chatbot's own booking (via ai.js's check_availability / book_appointment
 * tools) goes straight through services/availability.js, not through here —
 * this file exists for the *dashboard*: configuring working hours, previewing
 * slots, letting the owner book a walk-in manually, and cancelling bookings.
 */
const express = require('express');
const router = express.Router();

const { getSettings, saveSettings, getAvailableSlots, bookAppointment, cancelAppointment } = require('../services/availability');
const { listAppointments, countAppointments, assertPersistable } = require('../services/database');
const { asyncHandler } = require('../utils/errors');
const { perUser } = require('../middleware/rateLimit');
const { ValidationError, requireId, normalizePhone, optionalString, LIMITS } = require('../utils/validate');

/** Rejects a write when it cannot be durably stored (see database.js) — same guard routes/api.js applies to its own write endpoints. */
function requireDurableWrite(req, res, next) {
    assertPersistable();
    next();
}

const writeLimiter = perUser('appointments-write', {
    windowMs: 60 * 1000,
    max: 60,
    message: 'You are making changes very quickly. Please slow down and try again in a minute.'
});

// ─── Availability settings ─────────────────────────────────────
router.get('/settings', (req, res) => {
    res.json({ success: true, data: getSettings(req.user.id) });
});

router.put('/settings', writeLimiter, requireDurableWrite, (req, res) => {
    const body = req.body || {};
    const settings = saveSettings(req.user.id, {
        workingDays: body.workingDays,
        startTime: body.startTime,
        endTime: body.endTime,
        slotDurationMinutes: body.slotDurationMinutes,
        bufferMinutes: body.bufferMinutes,
        timezone: body.timezone,
        bookingEnabled: !!body.bookingEnabled
    });
    res.json({ success: true, data: settings });
});

// ─── Slot preview (dashboard + manual booking form) ────────────
router.get('/slots', asyncHandler(async (req, res) => {
    const daysAhead = req.query.daysAhead ? parseInt(req.query.daysAhead, 10) : undefined;
    const maxResults = req.query.maxResults ? parseInt(req.query.maxResults, 10) : undefined;
    const data = await getAvailableSlots(req.user.id, {
        daysAhead: Number.isFinite(daysAhead) ? daysAhead : undefined,
        maxResults: Number.isFinite(maxResults) ? maxResults : undefined
    });
    res.json({ success: true, data });
}));

// ─── Appointment list ───────────────────────────────────────────
router.get('/', (req, res) => {
    const status = req.query.status === 'cancelled' ? 'cancelled' : req.query.status === 'confirmed' ? 'confirmed' : null;
    res.json({
        success: true,
        data: {
            appointments: listAppointments(req.user.id, { status }),
            total: countAppointments(req.user.id)
        }
    });
});

// Owner books a slot manually from the dashboard (e.g. a walk-in or phone call) — same engine and same conflict checks as the chatbot.
router.post('/', writeLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const phone = normalizePhone(body.phone);
    const contactName = optionalString(body.contactName, 'contactName', 200);
    const notes = optionalString(body.notes, 'notes', LIMITS.APPOINTMENT_NOTES);
    if (!body.startIso) {
        throw new ValidationError('startIso is required.', 'startIso');
    }

    try {
        const appt = await bookAppointment(req.user.id, {
            phone, contactName, startIso: body.startIso, notes, source: 'dashboard'
        });
        res.json({ success: true, data: appt });
    } catch (err) {
        if (['SLOT_TAKEN', 'INVALID_SLOT', 'SLOT_IN_PAST', 'APPOINTMENT_LIMIT'].includes(err.code)) {
            return res.status(409).json({ success: false, error: err.message, code: err.code });
        }
        throw err;
    }
}));

router.delete('/:id', writeLimiter, asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'appointment id');
    const row = await cancelAppointment(req.user.id, id);
    if (!row) {
        return res.status(409).json({ success: false, error: 'That appointment was not found, or is already cancelled.' });
    }
    res.json({ success: true });
}));

module.exports = router;
