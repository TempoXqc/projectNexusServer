export function errorHandler(err, req, res, next) {
    console.error('Erreur serveur:', err.stack);
    res.status(500).json({ error: 'Erreur serveur' });
}
