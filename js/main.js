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
    
    // Download button - GitHub Releases
    const downloadBtn = document.getElementById('download-btn');
    if (downloadBtn) {
        downloadBtn.addEventListener('click', function(e) {
            const downloadUrl = 'https://github.com/JoeBarraco/BirdWatchAI-Releases/releases/download/v2.1.2.0/BirdWatchAI_Setup_2.1.2.0.exe';
            
            // Track download (if you add analytics later)
            console.log('Download initiated');
            
            // Start download
            window.location.href = downloadUrl;
        });
    }
    
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

    // Buy button - Gumroad product link
    const buyBtn = document.getElementById('buy-btn');
    if (buyBtn) {
        buyBtn.addEventListener('click', function(e) {
            e.preventDefault();

            const gumroadUrl = 'https://birdbrainllc.gumroad.com/l/dajhd';

            // Open in new tab for payment
            window.open(gumroadUrl, '_blank');
        });
    }

    // Buy The Nest (outdoor) button - Gumroad product link
    const buyNestBtn = document.getElementById('buy-nest-btn');
    if (buyNestBtn) {
        buyNestBtn.addEventListener('click', function(e) {
            e.preventDefault();

            const gumroadUrl = 'https://birdbrainllc.gumroad.com/l/irvwmy';

            // Open in new tab for payment
            window.open(gumroadUrl, '_blank');
        });
    }
    
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
     storage  30 GB $20, 250 GB $75
   So Nest Indoor = 50+20+40 = $110, and a full Wren Indoor build =
   50+20+40+(90+20) = $220. Change a number here and every total and
   every named build follows.
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

    const els = {
        total: document.getElementById('cfg-total'),
        name: document.getElementById('cfg-name'),
        lines: document.getElementById('cfg-lines'),
        hint: document.getElementById('cfg-hint'),
        storageRow: document.getElementById('cfg-storage-row'),
        selSoftware: document.getElementById('cfg-software'),
        selComputer: document.getElementById('cfg-computer')
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
        const softwareCost = software === 'none'
            ? 0
            : (hasHardware ? PRICES.softwareBundled : PRICES.softwareAlone);

        // Keep the price on each choice honest as the rest of the build changes:
        // the licence is cheaper alongside hardware, and each computer costs what
        // it costs with the storage currently selected.
        relabel(els.selSoftware, 'yes', hasHardware ? PRICES.softwareBundled : PRICES.softwareAlone);
        relabel(els.selComputer, 'standard', PRICES.computerBase.standard + PRICES.storage[storage]);
        relabel(els.selComputer, 'high', PRICES.computerBase.high + PRICES.storage[storage]);

        const lines = [];
        if (software !== 'none') lines.push(['BirdWatchAI license', softwareCost]);
        if (feeder !== 'none') lines.push([feeder === 'indoor' ? 'Indoor feeder' : 'Outdoor feeder', PRICES.feeder[feeder]]);
        if (camera !== 'none') lines.push(['Camera', PRICES.camera.yes]);
        if (hasComputer) {
            const label = (computer === 'standard' ? 'Standard' : 'High Performance') +
                ' computer, ' + (storage === 'standard' ? '30 GB' : '250 GB');
            lines.push([label, computerCost]);
        }
        if (macro) lines.push(['Macro lens', PRICES.macro]);

        const total = lines.reduce((sum, l) => sum + l[1], 0);

        els.lines.innerHTML = lines.length
            ? lines.map(l => '<li><span>' + l[0] + '</span><span>' + money(l[1]) + '</span></li>').join('')
            : '<li class="cfg-line-empty"><span>Nothing selected yet</span><span></span></li>';

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
        } else if (!lines.length) {
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

    form.addEventListener('change', safeRender);
    form.addEventListener('input', safeRender);
    safeRender();
});
