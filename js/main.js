/** 
 * BirdWatchAI Website JavaScript
 */

document.addEventListener('DOMContentLoaded', function() {
    // Mobile navigation toggle
    const navToggle = document.querySelector('.nav-mobile-toggle');
    const navLinks = document.querySelector('.nav-links');
    
    if (navToggle && navLinks) {
        navToggle.addEventListener('click', function() {
            navLinks.classList.toggle('active');
            // Animate hamburger to X
            this.classList.toggle('active');
            // Update aria-expanded for accessibility
            var expanded = navLinks.classList.contains('active');
            this.setAttribute('aria-expanded', expanded);
        });

        // Close mobile nav when clicking a link
        navLinks.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => {
                navLinks.classList.remove('active');
                navToggle.classList.remove('active');
                navToggle.setAttribute('aria-expanded', 'false');
            });
        });
    }
    
    // Smooth scroll for anchor links (fallback for browsers without CSS scroll-behavior)
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                e.preventDefault();
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });
    
    // Navigation background on scroll
    const nav = document.querySelector('.nav');
    let lastScroll = 0;
    
    window.addEventListener('scroll', () => {
        const currentScroll = window.pageYOffset;
        
        if (currentScroll > 50) {
            nav.style.boxShadow = '0 2px 20px rgba(45, 90, 61, 0.1)';
        } else {
            nav.style.boxShadow = 'none';
        }
        lastScroll = currentScroll;
    });
    
    // The old #download-btn handler lived here: it hijacked the hero/download
    // button and sent every visitor to the WinForms desktop installer, pinned to
    // an exact version so each release needed a code edit. The desktop app is
    // retired; the server edition installs with Docker and has no single file to
    // hand over, so the download section now links to the two install guides and
    // the legacy installer is a plain <a> in a collapsed footnote. Nothing to
    // wire up here.


    // Screensaver download button - GitHub Releases
    const screensaverBtn = document.getElementById('screensaver-download-btn');
    if (screensaverBtn) {
        screensaverBtn.addEventListener('click', function(e) {
            e.preventDefault();
            const screensaverUrl = 'https://github.com/JoeBarraco/BirdWatchAI-Releases/releases/download/v2.1.2.0/BirdWatchAI_Screensaver_1.0.0.zip';
            console.log('Screensaver download initiated');
            window.location.href = screensaverUrl;
        });
    }

    // Server/Camera finder download button - GitHub Releases (server-releases repo)
    const finderBtn = document.getElementById('finder-download-btn');
    if (finderBtn) {
        finderBtn.addEventListener('click', function(e) {
            e.preventDefault();
            const finderUrl = 'https://github.com/JoeBarraco/birdwatchai-server-releases/releases/latest/download/BirdWatchFinder.exe';
            console.log('Finder download initiated');
            window.location.href = finderUrl;
        });
    }

    // The #buy-btn and #buy-nest-btn handlers lived here. Both buttons went
    // when pricing moved into the builder, and the second still pointed at the
    // BYOC listing that the new Nest products replace. The builder writes its
    // own Gumroad links now, so there is nothing to wire up here.
    // Intersection Observer for scroll animations
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.opacity = '1';
                entry.target.style.transform = 'translateY(0)';
            }
        });
    }, observerOptions);
    
    // Observe all feature cards and other animated elements
    document.querySelectorAll('.feature-card, .step, .pricing-card, .faq-item, .requirement-card, .gallery-item').forEach(el => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(20px)';
        el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
        observer.observe(el);
    });
    
    // Add stagger delay to grid items
    document.querySelectorAll('.features-grid .feature-card').forEach((card, index) => {
        card.style.transitionDelay = `${index * 0.1}s`;
    });
    
    document.querySelectorAll('.faq-grid .faq-item').forEach((item, index) => {
        item.style.transitionDelay = `${index * 0.1}s`;
    });
});

// Utility function for future use - format currency
function formatCurrency(amount, currency = 'USD') {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 0
    }).format(amount);
}

// Console Easter egg for developers
console.log('%c🐦 BirdWatchAI', 'font-size: 24px; font-weight: bold; color: #2d5a3d;');
console.log('%cAutomatic bird detection for your backyard feeders.', 'color: #7a756d;');
console.log('%cInterested in how this works? Check out the GitHub: https://github.com/JoeBarraco/BirdWatchAI', 'color: #3d7a52;');

/* ──────────────────────────────────────────────────────────────
   Build-your-own configurator (Tier 3)

   Every price here is a component price, and the bundles the page
   used to list as fixed cards fall out of adding them up:
     software $50 with hardware / $75 alone
     feeder   indoor $20, outdoor $40
     camera   $40
     computer standard $90 + storage, high performance $140 + storage
     storage  32 GB $20, 256 GB $75
   So Nest Indoor = 50+20+40 = $110, and a full Wren Indoor build =
   50+20+40+(90+20) = $220. Change a number here and every total and
   every named build follows.

   On top of that, shipping: free at $100 or more, otherwise a flat $25,
   and never on a digital-only order. See SHIPPING below.
   ────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function () {
    const form = document.getElementById('cfg-form');
    if (!form) return;

    const PRICES = {
        softwareBundled: 50,
        softwareAlone: 75,
        feeder: { none: 0, indoor: 20, outdoor: 40 },
        camera: { none: 0, yes: 40 },
        computerBase: { none: 0, standard: 90, high: 140 },
        storage: { standard: 20, extended: 75 },
        macro: 25
    };

    // A complete build (software + feeder + camera + computer) is one of the
    // four named tiers. Anything else is just a custom build.
    const TIER_NAMES = {
        'standard|standard': 'The Wren',
        'standard|extended': 'The Finch',
        'high|standard': 'The Jay',
        'high|extended': 'The Cardinal'
    };

    /* Gumroad wiring.

       Two ways to buy, because Gumroad supports two and they suit different
       builds:

       BUNDLES are single products covering a whole build — one click, one
       checkout. Best where one exists.

       COMPONENTS are added to Gumroad's cart one at a time, via
       gumroad.com/checkout?product=<permalink>. There is no URL that adds
       several at once (?product= repeated keeps only the last, and product[],
       products= and comma-separated forms add nothing), but adds do
       accumulate, so a build becomes one link per line and a single checkout.
       The cart holds up to 50 products, far more than any build needs.

       To switch a component on, create the product in Gumroad at the price
       shown and paste its permalink here — the bit after /l/. Anything left
       null makes builds needing it fall back to Coming Soon, so half-finished
       wiring cannot send someone to a checkout that is missing pieces. */
    const GUMROAD_CART = 'https://gumroad.com/checkout?product=';

    const COMPONENTS = {
        software:        { permalink: 'dajhd',  price: 75,  label: 'BirdWatchAI license' },
        feederIndoor:    { permalink: 'ittcdq', price: 20,  label: 'Indoor feeder' },
        feederOutdoor:   { permalink: 'pqwifk', price: 40,  label: 'Outdoor feeder' },
        camera:          { permalink: 'mnrvz',  price: 40,  label: 'Camera' },
        macro:           { permalink: 'ujgfpc', price: 25,  label: 'Macro lens' },
        computerStdStd:  { permalink: 'icpxmz', price: 110, label: 'Standard computer, 32 GB' },
        computerStdExt:  { permalink: 'mkvszs', price: 165, label: 'Standard computer, 256 GB' },
        computerHighStd: { permalink: 'unfzhr', price: 160, label: 'High Performance computer, 32 GB' },
        computerHighExt: { permalink: 'cnnotb', price: 215, label: 'High Performance computer, 256 GB' }
    };

    /* Bundles are single Gumroad products covering several components at a
       lower price — the $25 saving is the software discount, expressed here
       rather than as a discounted licence product, so no cheap licence is
       ever purchasable on its own.

       `contains` lets a bundle be matched even when the build has extras: the
       best-value bundle whose contents are a subset of the build is used, and
       whatever is left over is added as components. So a Full Nest plus a
       macro lens is two cart adds, not five. */
    const BUNDLES = [
        { permalink: 'nuhhw',   price: 110, label: 'The Nest — Indoor',
          contains: ['software', 'feederIndoor', 'camera'] },
        { permalink: 'dtqrunq', price: 130, label: 'The Nest — Outdoor',
          contains: ['software', 'feederOutdoor', 'camera'] },
        { permalink: 'nbnqg',   price: 220, label: 'The Wren — Indoor',
          contains: ['software', 'feederIndoor', 'camera', 'computerStdStd'] },
        { permalink: 'umvcj',   price: 275, label: 'The Finch — Indoor',
          contains: ['software', 'feederIndoor', 'camera', 'computerStdExt'] },
        { permalink: 'tlvqwi',  price: 270, label: 'The Jay — Indoor',
          contains: ['software', 'feederIndoor', 'camera', 'computerHighStd'] },
        { permalink: 'nbtwam',  price: 325, label: 'The Cardinal — Indoor',
          contains: ['software', 'feederIndoor', 'camera', 'computerHighExt'] },
        { permalink: 'lyzizr',  price: 240, label: 'The Wren — Outdoor',
          contains: ['software', 'feederOutdoor', 'camera', 'computerStdStd'] },
        { permalink: 'zfgmyp',  price: 295, label: 'The Finch — Outdoor',
          contains: ['software', 'feederOutdoor', 'camera', 'computerStdExt'] },
        { permalink: 'fvypf',   price: 290, label: 'The Jay — Outdoor',
          contains: ['software', 'feederOutdoor', 'camera', 'computerHighStd'] },
        { permalink: 'siqskd',  price: 345, label: 'The Cardinal — Outdoor',
          contains: ['software', 'feederOutdoor', 'camera', 'computerHighExt'] }
    ];

    /* Shipping & handling.

       Free at the threshold or above, a flat fee below it, and never charged
       on a digital-only order — nothing ships when the license is all you buy.
       The threshold is measured on the POST-discount subtotal, i.e. what is
       actually paid, so $100 exactly ships free.

       Gumroad's own shipping is per-product, which can express neither half of
       that rule: a two-item small cart would pay the fee twice, and no
       per-product setting can make a $105 order free. So shipping is set to $0
       on every Gumroad product and the fee rides along as its own product,
       leaving the threshold logic here.

       The permalink stays null until that product exists in Gumroad. Same
       convention as COMPONENTS above: null makes the builds that need it fall
       back to Coming Soon, rather than sending someone to a checkout that is
       missing the fee. */
    const SHIPPING = {
        permalink: 'gktxni',
        price: 25,
        threshold: 100,
        label: 'Shipping & Handling'
    };

    /* Shipping-inclusive products.

       The fee riding along as its own cart item has one flaw the buyer can
       exploit without meaning to: it is a line in the Gumroad cart like any
       other, and it can be deleted there. The build then ships for free and we
       eat $25. Baking the fee into a single product removes the line, so there
       is nothing to remove.

       Only builds BELOW the threshold need one, and only eleven exist — every
       computer starts at $110, so any build with one already ships free, and
       the two feeders are mutually exclusive. The key is the build's component
       list, sorted and joined; the price is the discounted subtotal plus the
       fee. None of the eleven matches a bundle, so each replaces a pure
       component cart.

       Same null convention as everywhere else, but a softer fallback: a null
       permalink here does NOT mean Coming Soon, it means "sell this the old
       way" — components plus the separate fee. That lets these be created a
       few at a time (Gumroad caps product creation at 10 a day) with each one
       going live the moment its permalink is pasted in, and nothing breaking
       in between.

       Two traps when creating them:
        - Turn ON "Require shipping address". Gumroad has no Physical good
          type any more; this toggle is what collects an address, and without
          it you take the money with nowhere to send the feeder. A Bundle
          cannot set it directly, but inherits it from any item inside that
          requires shipping — so a bundle built from the physical components
          collects an address as long as those components do.
        - 'feederIndoor+software' includes a license, so build it as a BUNDLE
          containing dajhd. Gumroad reports the contained license rather than
          the bundle wrapper, so a bundle needs no GUMROAD_PRODUCT_ID change;
          a standalone product would report its own id, match nothing, and the
          buyer would pay $120 and never get a key. */
    const SHIPPED = {
        'feederIndoor':              { permalink: 'asuoeh', price: 45,  label: 'Indoor Feeder — delivered' },
        'macro':                     { permalink: null, price: 50,  label: 'Macro Lens — delivered' },
        'camera':                    { permalink: null, price: 65,  label: 'Camera — delivered' },
        'feederOutdoor':             { permalink: null, price: 65,  label: 'Outdoor Feeder — delivered' },
        'feederIndoor+macro':        { permalink: null, price: 70,  label: 'Indoor Feeder + Macro Lens — delivered' },
        'camera+feederIndoor':       { permalink: null, price: 85,  label: 'Indoor Feeder + Camera — delivered' },
        'camera+macro':              { permalink: null, price: 90,  label: 'Camera + Macro Lens — delivered' },
        'feederOutdoor+macro':       { permalink: null, price: 90,  label: 'Outdoor Feeder + Macro Lens — delivered' },
        'camera+feederOutdoor':      { permalink: null, price: 105, label: 'Outdoor Feeder + Camera — delivered' },
        'camera+feederIndoor+macro': { permalink: null, price: 110, label: 'Indoor Feeder + Camera + Macro Lens — delivered' },
        'feederIndoor+software':     { permalink: null, price: 120, label: 'BirdWatchAI License + Indoor Feeder — delivered' }
    };

    const els = {
        total: document.getElementById('cfg-total'),
        name: document.getElementById('cfg-name'),
        lines: document.getElementById('cfg-lines'),
        hint: document.getElementById('cfg-hint'),
        storageRow: document.getElementById('cfg-storage-row'),
        selSoftware: document.getElementById('cfg-software'),
        selComputer: document.getElementById('cfg-computer'),
        buy: document.getElementById('cfg-buy'),
        soon: document.getElementById('cfg-soon'),
        cart: document.getElementById('cfg-cart'),
        footnote: document.getElementById('cfg-footnote')
    };

    const money = n => '$' + n;
    const pick = name => {
        const el = form.elements[name];
        return el ? el.value : 'none';
    };

    // Re-label an option in place, keeping its base text and appending a price.
    const relabel = (select, value, price) => {
        const opt = select && select.querySelector('option[value="' + value + '"]');
        if (opt && opt.dataset.label) opt.textContent = opt.dataset.label + ' (' + money(price) + ')';
    };

    // Which add-to-cart links have been clicked, and for which build. Gumroad
    // cannot tell us what is in the cart, so this only records that a link was
    // followed — enough to stop someone reaching checkout before adding anything.
    let cartSignature = '';
    const cartAdded = new Set();

    function render() {
        const software = pick('software');
        const feeder = pick('feeder');
        const camera = pick('camera');
        const computer = pick('computer');
        const storage = pick('storage');
        const macro = pick('macro') === 'yes';

        const hasComputer = computer !== 'none';
        const storageCost = hasComputer ? PRICES.storage[storage] : 0;
        const computerCost = PRICES.computerBase[computer] + storageCost;

        // Storage only means anything alongside a computer.
        if (els.storageRow) els.storageRow.classList.toggle('cfg-row-disabled', !hasComputer);
        if (form.elements.storage) form.elements.storage.disabled = !hasComputer;

        const hasHardware = feeder !== 'none' || camera !== 'none' || hasComputer || macro;
        const softwareCost = software === 'none' ? 0 : PRICES.softwareAlone;

        // Each computer costs what it costs with the storage currently selected.
        relabel(els.selSoftware, 'yes', PRICES.softwareAlone);
        relabel(els.selComputer, 'standard', PRICES.computerBase.standard + PRICES.storage[storage]);
        relabel(els.selComputer, 'high', PRICES.computerBase.high + PRICES.storage[storage]);

        // Every piece gets a line, in or out. Leaving the skipped ones off the
        // list hid what a build was missing — the whole point of the summary is
        // that you can see you are not getting a feeder.
        const lines = [
            software !== 'none'
                ? ['BirdWatchAI license', softwareCost]
                : ['Software', null],
            feeder !== 'none'
                ? [feeder === 'indoor' ? 'Indoor feeder' : 'Outdoor feeder', PRICES.feeder[feeder]]
                : ['Feeder', null],
            camera !== 'none'
                ? ['Camera', PRICES.camera.yes]
                : ['Camera', null],
            hasComputer
                ? [(computer === 'standard' ? 'Standard' : 'High Performance') + ' computer, ' +
                   (storage === 'standard' ? '32 GB' : '256 GB'), computerCost]
                : ['Computer', null],
            macro
                ? ['Macro lens', PRICES.macro]
                : ['Macro lens', null]
        ];

        const listTotal = lines.reduce((sum, l) => sum + (l[1] || 0), 0);

        // Which components this build needs, in the order they are listed.
        const parts = [];
        if (software !== 'none') parts.push('software');
        if (feeder === 'indoor') parts.push('feederIndoor');
        if (feeder === 'outdoor') parts.push('feederOutdoor');
        if (camera !== 'none') parts.push('camera');
        if (hasComputer) {
            parts.push(computer === 'standard'
                ? (storage === 'standard' ? 'computerStdStd' : 'computerStdExt')
                : (storage === 'standard' ? 'computerHighStd' : 'computerHighExt'));
        }
        if (macro) parts.push('macro');

        // Best bundle whose contents this build fully covers. Ties go to the one
        // covering more pieces, so a Full Nest wins over the Nest kit inside it.
        let bundle = null, bundleSaving = 0;
        BUNDLES.forEach(b => {
            if (!b.contains.every(p => parts.includes(p))) return;
            const value = b.contains.reduce((s, p) => s + COMPONENTS[p].price, 0);
            const saving = value - b.price;
            if (!bundle || saving > bundleSaving ||
                (saving === bundleSaving && b.contains.length > bundle.contains.length)) {
                bundle = b;
                bundleSaving = saving;
            }
        });

        const leftovers = bundle ? parts.filter(p => !bundle.contains.includes(p)) : parts;
        const subtotal = listTotal - bundleSaving;

        // Shipping is decided on the discounted subtotal, so the threshold is
        // measured against what is actually paid. The headline total includes
        // the fee — a total here that disagrees with the Gumroad checkout total
        // is the bug you would hear about.
        const needsShipping = hasHardware && subtotal < SHIPPING.threshold;
        const total = subtotal + (needsShipping ? SHIPPING.price : 0);

        // Sold as one product with the fee already inside it, if that product
        // has been created yet. Until then this build falls back to the
        // component adds plus the separate fee, exactly as before.
        const shipped = needsShipping ? SHIPPED[parts.slice().sort().join('+')] : null;
        const useShipped = !!(shipped && shipped.permalink);

        // Free shipping earns a line of its own even though it adds nothing to
        // the total: a rule nobody can see sells nothing.
        const shippingLine = !hasHardware
            ? ''
            : needsShipping
                ? '<li><span>Shipping &amp; Handling' + (useShipped ? ' <em>(included)</em>' : '') +
                  '</span><span>' + money(SHIPPING.price) + '</span></li>'
                : '<li class="cfg-line-saving"><span>Shipping</span><span>Free</span></li>';

        els.lines.innerHTML = lines.map(l => l[1] === null
            ? '<li class="cfg-line-out"><span>' + l[0] + '</span><span>Not included</span></li>'
            : '<li><span>' + l[0] + '</span><span>' + money(l[1]) + '</span></li>'
        ).join('') + (bundleSaving > 0
            ? '<li class="cfg-line-saving"><span>' + bundle.label + ' saving</span><span>&minus;' + money(bundleSaving) + '</span></li>'
            : '') + shippingLine;

        // Flash the total when it moves. On a narrow screen the summary can sit
        // below the fold of whatever you just changed, so a silent update reads
        // as nothing having happened.
        const next = money(total);
        if (els.total.textContent !== next) {
            els.total.textContent = next;
            els.total.classList.remove('cfg-total-bumped');
            void els.total.offsetWidth; // restart the animation
            els.total.classList.add('cfg-total-bumped');
        }

        // Name the build when it is one of the four complete tiers.
        const complete = software !== 'none' && feeder !== 'none' && camera !== 'none' && hasComputer;
        const style = feeder === 'indoor' ? 'Indoor' : 'Outdoor';
        let name;
        if (complete) {
            name = TIER_NAMES[computer + '|' + storage] + ' — ' + style;
        } else if (software !== 'none' && feeder !== 'none' && camera !== 'none') {
            name = 'The Nest — ' + style;
        } else if (software !== 'none' && !hasHardware) {
            name = 'BirdWatchAI Software';
        } else if (subtotal === 0) {
            name = 'Nothing selected';
        } else {
            name = 'Custom build';
        }
        els.name.textContent = name;

        // The computer ships with the app preinstalled but not licensed, so
        // say so rather than letting someone buy a machine that runs as a trial.
        let hint = '';
        if (hasComputer && software === 'none') {
            hint = 'The computer arrives with BirdWatchAI preinstalled, but it runs as a 14-day trial until a license is added.';
        } else if (camera === 'none' && (feeder !== 'none' || hasComputer)) {
            hint = 'You will need an RTSP camera pointed at the feeder for this to identify anything.';
        }
        els.hint.textContent = hint;
        els.hint.hidden = !hint;

        // What actually goes in the cart: the bundle, if one matched, then
        // whatever it did not cover.
        const cartItems = useShipped
            ? [shipped]
            : (bundle ? [{ permalink: bundle.permalink, label: bundle.label, price: bundle.price }] : [])
                .concat(leftovers.map(p => COMPONENTS[p]));
        if (needsShipping && !useShipped) cartItems.push(SHIPPING);
        const buyable = cartItems.length > 0 && cartItems.every(c => c.permalink);

        els.buy.hidden = true;
        els.soon.hidden = true;
        els.cart.hidden = true;

        if (buyable && cartItems.length === 1) {
            const only = cartItems[0];
            els.buy.href = (bundle || useShipped)
                ? 'https://birdbrainllc.gumroad.com/l/' + only.permalink
                : GUMROAD_CART + encodeURIComponent(only.permalink);
            els.buy.textContent = 'Buy ' + only.label + ' — ' + money(total);
            els.buy.hidden = false;
        } else if (buyable) {
            /* One link per item, because Gumroad has no multi-add URL. Each
               link adds its product and lands on the checkout page, so the
               last one clicked is already the finished cart.

               The earlier version put a big "Go to checkout" button under a
               list of plain text links, so the obvious thing to click went
               straight to an empty cart. Now each item is the button, the
               ones already added are ticked off, and checkout stays disabled
               until none are left. */
            const sig = cartItems.map(c => c.permalink).join(',');
            if (sig !== cartSignature) { cartSignature = sig; cartAdded.clear(); }
            const remaining = cartItems.filter(c => !cartAdded.has(c.permalink)).length;

            els.cart.innerHTML =
                '<p class="cfg-cart-lead">' + (remaining
                    ? 'Add each item, then use your browser’s Back button to return here. Your build is remembered. The last item leaves you at checkout.'
                    : 'All added. Your cart should hold ' + cartItems.length + ' items totalling ' + money(total) + '.') +
                '</p>' +
                '<ol class="cfg-cart-list">' +
                cartItems.map(c => {
                    const done = cartAdded.has(c.permalink);
                    return '<li><a class="cfg-add' + (done ? ' cfg-add-done' : '') +
                        '" data-perm="' + c.permalink + '" href="' + GUMROAD_CART + encodeURIComponent(c.permalink) + '">' +
                        '<span class="cfg-add-tick" aria-hidden="true">' + (done ? '✓' : '+') + '</span>' +
                        '<span class="cfg-add-label">' + c.label + '</span>' +
                        '<span class="cfg-add-price">' + money(c.price) + '</span></a></li>';
                }).join('') +
                '</ol>' +
                (remaining
                    ? '<p class="cfg-cart-foot">' + remaining + ' still to add</p>'
                    : '<a class="btn btn-primary btn-block" href="https://gumroad.com/checkout" target="_blank" rel="noopener">Go to checkout — ' + money(total) + '</a>');

            els.cart.querySelectorAll('.cfg-add').forEach(a => {
                a.addEventListener('click', function () {
                    // Runs just before the browser leaves for Gumroad, so the
                    // tick has to be written out here or Back forgets it.
                    cartAdded.add(this.dataset.perm);
                    saveState();
                    safeRender();
                });
            });
            els.cart.hidden = false;
        } else {
            els.soon.hidden = false;
        }

        if (els.footnote) {
            els.footnote.textContent = buyable
                ? (useShipped
                    ? 'Secure payment via Gumroad. The ' + money(SHIPPING.price) + ' shipping & handling is already in this price — free on builds of ' + money(SHIPPING.threshold) + ' or more.'
                    : needsShipping
                        ? 'Secure payment via Gumroad. Shipping is a separate ' + money(SHIPPING.price) + ' item in the cart — free on builds of ' + money(SHIPPING.threshold) + ' or more.'
                        : 'Secure payment via Gumroad. Your license key is emailed within 24 hours.')
                : (subtotal === 0
                    ? 'Choose at least one piece to see a price.'
                    : 'That combination cannot be ordered as it stands. Add or change a piece and the price will appear.');
        }
    }

    // A throw inside render() would leave the total frozen on whatever it last
    // showed, which looks exactly like "the price doesn't update" — the failure
    // mode when cached JS meets newer HTML. Say so instead of going quiet.
    function safeRender() {
        try {
            render();
        } catch (err) {
            console.error('Configurator failed to update:', err);
            if (els.hint) {
                els.hint.textContent = 'Something went wrong updating this price. Please refresh the page.';
                els.hint.hidden = false;
            }
        }
    }

    /* Adding an item means leaving the page for Gumroad, so the build and the
       progress through it have to survive the trip back. sessionStorage rather
       than localStorage: this is one shopping session, not a saved preference. */
    const STORE = 'bwa-build-v1';

    function saveState() {
        try {
            const cfg = {};
            ['software', 'feeder', 'camera', 'computer', 'storage', 'macro']
                .forEach(k => { if (form.elements[k]) cfg[k] = form.elements[k].value; });
            sessionStorage.setItem(STORE, JSON.stringify({
                cfg: cfg, sig: cartSignature, added: Array.from(cartAdded)
            }));
        } catch (e) { /* private browsing, or storage full — not worth failing over */ }
    }

    function restoreState() {
        try {
            const raw = sessionStorage.getItem(STORE);
            if (!raw) return;
            const s = JSON.parse(raw);
            Object.keys(s.cfg || {}).forEach(k => {
                const el = form.elements[k];
                if (el && s.cfg[k]) { el.disabled = false; el.value = s.cfg[k]; }
            });
            cartSignature = s.sig || '';
            (s.added || []).forEach(p => cartAdded.add(p));
        } catch (e) { /* ignore a malformed or unreadable entry */ }
    }

    restoreState();

    form.addEventListener('change', function () { safeRender(); saveState(); });
    form.addEventListener('input', function () { safeRender(); saveState(); });
    safeRender();

    /* Coming back from Gumroad — whether by Back or by its "Continue shopping"
       link — lands at the top of the page, a long way above the builder, with
       no sign of the half-finished build waiting below. If items have already
       been added, put the builder back on screen.

       Deferred a frame so it runs after the browser's own scroll restoration,
       which would otherwise fight it. */
    if (cartAdded.size) {
        // Stop the browser restoring its own scroll position and undoing this.
        try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch (e) {}

        // Aim at the widget itself, not the section — #build starts with the
        // eyebrow and heading, so landing on it leaves the dropdowns and the
        // total below the fold, which is most of the way there but not there.
        const widget = () => document.getElementById('configurator') || document.getElementById('build');
        const jump = () => { const t = widget(); if (t) t.scrollIntoView({ block: 'start' }); };

        /* Everything above the builder — hero, screenshots, feeder and computer
           photos — is still loading, and every image that lands pushes the
           target further down, so a single jump aims at where the page used to
           be. Re-aim whenever the target's absolute position changes, until it
           stops moving or we run out of patience. */
        /* Retry until we have actually arrived, not merely until the layout
           stops moving. The previous version re-aimed only when the target's
           position changed, so a jump that fell short on a page that was not
           yet tall enough was never corrected — which is exactly what happens
           on a cold load, where the document grows as images arrive. */
        const OFFSET = 96;  // matches scroll-margin-top on #configurator
        let tries = 0;
        const settle = () => {
            const t = widget();
            if (!t) return;
            const off = Math.abs(Math.round(t.getBoundingClientRect().top) - OFFSET);
            const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
            // atBottom means the page simply cannot scroll any further; stop
            // rather than yanking the view every 200ms forever.
            if (off > 8 && !atBottom) jump();
            if (++tries < 20) setTimeout(settle, 200);
        };
        jump();
        settle();

        const panel = document.querySelector('.cfg-summary');
        if (panel) {
            panel.classList.add('cfg-summary-resumed');
            setTimeout(function () { panel.classList.remove('cfg-summary-resumed'); }, 1800);
        }
    }
});
