// 📦 BANQUES DE DONNÉES ET ÉTATS DU BOT TITAN

module.exports = {
  COMMENTAIRES_LOVE: {
    parfait: ["Une alchimie parfaite ! 💖", "C'est l'amour fou ! 😍", "Faits l'un pour l'autre ! ✨"],
    moyen: ["Il y a un potentiel ! 🙂", "Ça se tente ! 😉", "À travailler avec le temps ! ⏳"],
    faible: ["L'amitié c'est bien aussi... 😅", "Aïe, zone de danger ! 💔", "Compatibilité minimale... 😬"]
  },

  LISTE_ANIMAUX: [
    { nom: "Chien", type: "canin", nourriture: "croquettes" },
    { nom: "Chat", type: "félin", nourriture: "poisson" },
    { nom: "Dragon", type: "mythique", nourriture: "viande grillée" },
    { nom: "Panda", type: "mammifère", nourriture: "bambou" }
  ],

  MOTS_SQUID: ["BOUGER", "STOP", "COURIR", "AVANCER", "DANGER", "SOLEIL", "FEU"],

  DONNEES_DETECTIVE_BOOSTE: {
    suspects: ["Lord Blackwood", "Lady Clara", "Le Chef Cook", "Le Valet James"],
    lieux: ["Le Salon", "La Bibliothèque", "La Cuisine", "Le Jardin"],
    armes: ["Poignard", "Poison", "Corde", "Revolver"],
    temoignagesFaux: [
      "Un serviteur affirme avoir vu de la lumière dans le jardin.",
      "Une ombre a été aperçue près de la cuisine.",
      "Un bruit de verre brisé a retenti près du salon."
    ]
  },

  DONNEES_CERVEAU: [
    "🧠 Analyse réflexe",
    "💡 Logique et Raisonnement",
    "⚡ Vitesse de décision",
    "🎭 Sang-froid"
  ],

  COMMENTAIRES_CERVEAU: [
    "Cerveau très équilibré et réactif ! ⚡",
    "Capacités d'analyse hors du commun ! 🧠",
    "Un peu étourdi mais un grand potentiel ! 💡"
  ],

  MESSAGE_SECRET_ANDY: "🔒 *SECRET D'ANDY :* Le projet Titan a été conçu pour dominer tous les bots WhatsApp ! 🚀",

  CHEMINS_LABYRINTHE: [
    ["gauche", "tout droit", "droite", "gauche", "tout droit", "droite", "gauche", "tout droit", "droite", "tout droit"],
    ["droite", "gauche", "tout droit", "droite", "gauche", "tout droit", "droite", "gauche", "tout droit", "gauche"]
  ],

  SUBS_LABYRINTHE: [
    "Vous marchez à tCover dans l'obscurité...",
    "Un bruit étrange résonne dans le couloir...",
    "La température baisse soudainement..."
  ],

  // 💾 MÉMOIRES ET ÉTATS DU BOT
  partiesEnCours: {},
  timersInactivite: {},
  vueUniqueCache: {},
  animauxJoueurs: {},
  mesNotes: {},
  sessionsMotDePasse: {},
  profilsJoueurs: {},
  membresSalues: new Set(),
  sessionsSecretAndy: {}
};
