// ════════════════════════════════════════════════════════════════════
//  Bird song, for the classroom
// ════════════════════════════════════════════════════════════════════
//
//  GENERATED. Do not hand-edit — rerun tools/fetch-bird-sounds.js.
//
//  Recordings from Wikimedia Commons, every one under a licence that
//  permits commercial reuse. CC BY and CC BY-SA REQUIRE the author and
//  the licence to be shown wherever the recording is played, which is why
//  the attribution travels in this file rather than living in somebody's
//  notes — the slide renders what is recorded here, and if it is wrong
//  here it is wrong on the projector.
//
//  Fetched: 2026-11-23
// ════════════════════════════════════════════════════════════════════

const BIRD_SOUND_FILES = {
    "Barred Owl": {
        file:    "audio/birds/barred-owl.mp3",
        artist:  "Matthias Sirch",
        licence: "CC BY-SA 4.0",
        licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
        source:  "https://commons.wikimedia.org/wiki/File:Strix_varia_-_Northern_Barred_Owl_XC375201.mp3",
    },
    "Carolina Chickadee": {
        file:    "audio/birds/carolina-chickadee.ogg",
        artist:  "G. McGrane",
        licence: "Public domain",
        licenceUrl: "",
        source:  "https://commons.wikimedia.org/wiki/File:Carolina_Chickadee.ogg",
    },
    "Eastern Towhee": {
        file:    "audio/birds/eastern-towhee.mp3",
        artist:  "Jonathon Jongsma",
        licence: "CC BY-SA 4.0",
        licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
        source:  "https://commons.wikimedia.org/wiki/File:Pipilo_erythrophthalmus_-_Eastern_Towhee_XC320489.mp3",
    },
    "White-throated Sparrow": {
        file:    "audio/birds/white-throated-sparrow.mp3",
        artist:  "Doug Hynes",
        licence: "CC BY-SA 4.0",
        licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
        source:  "https://commons.wikimedia.org/wiki/File:Zonotrichia_albicollis_-_White-throated_Sparrow_XC569523.mp3",
    },
    "Killdeer": {
        file:    "audio/birds/killdeer.mp3",
        artist:  "Jonathon Jongsma",
        licence: "CC BY-SA 3.0",
        licenceUrl: "https://creativecommons.org/licenses/by-sa/3.0",
        source:  "https://commons.wikimedia.org/wiki/File:Charadrius_vociferus_-_Killdeer_XC62728.mp3",
    },
    "Mourning Dove": {
        file:    "audio/birds/mourning-dove.oga",
        artist:  "Francis C, Ortega C, Cruz A",
        licence: "CC BY 2.5",
        licenceUrl: "https://creativecommons.org/licenses/by/2.5",
        source:  "https://commons.wikimedia.org/wiki/File:Zenaida_macroura_vocalizations_-_pone.0027052.s009.oga",
    },
    "Northern Cardinal": {
        file:    "audio/birds/northern-cardinal.mp3",
        artist:  "Eric B",
        licence: "CC BY-SA 4.0",
        licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
        source:  "https://commons.wikimedia.org/wiki/File:Cardinalis_cardinalis_-_Northern_Cardinal_XC569289.mp3",
    },
    "Blue Jay": {
        file:    "audio/birds/blue-jay.mp3",
        artist:  "Jonathon Jongsma",
        licence: "CC BY-SA 4.0",
        licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
        source:  "https://commons.wikimedia.org/wiki/File:Cyanocitta_cristata_-_Blue_Jay_XC175223.mp3",
    },
    "American Crow": {
        file:    "audio/birds/american-crow.mp3",
        artist:  "Jonathon Jongsma",
        licence: "CC BY-SA 3.0",
        licenceUrl: "https://creativecommons.org/licenses/by-sa/3.0",
        source:  "https://commons.wikimedia.org/wiki/File:Corvus_brachyrhynchos_-_American_Crow_XC115429.mp3",
    },
    "Tufted Titmouse": {
        file:    "audio/birds/tufted-titmouse.ogg",
        artist:  "U. S. Fish and Wildlife Service",
        licence: "Public domain",
        licenceUrl: "",
        source:  "https://commons.wikimedia.org/wiki/File:Tufted_Titmouse_call.ogg",
    },
};

/**
 * The recording for a species, or null.
 *
 * Null is an ordinary answer: most feeder birds have no acceptable
 * recording on Commons, and a question that wanted one simply falls back
 * to its written mnemonic.
 */
function birdSound(species) {
    return (typeof BIRD_SOUND_FILES !== 'undefined' && BIRD_SOUND_FILES[species]) || null;
}
