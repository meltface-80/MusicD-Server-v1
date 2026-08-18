const express = require('express');
const router = express.Router();
const shareCard = require('../shareCard');

router.get('/now-playing.png', async (req, res) => {
  try {
    const png = await shareCard.generateForCurrent();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(png);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/album/:id.png', async (req, res) => {
  try {
    const png = await shareCard.generateForAlbum(req.params.id);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(png);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
