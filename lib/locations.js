// Shared delivery-location data and room autocomplete.
//
// Extracted from customer/order.html so the coffee order page and the sticker
// sheet page render the same room suggestions from one list.  Loaded as a
// plain script; everything below is a global, matching the rest of the site.
//
// initLocationAutocomplete(inputId, getLocations) expects markup shaped like:
//   <input id="delivery-room" ...>
//   <div class="autocomplete-dropdown" id="ac-delivery-room" role="listbox"></div>
// getLocations() returns the array to search, so each page can decide between
// the high school and Mathews lists at call time.

const NHS_LOCATIONS = [
  // Teachers (Last, First — Subject : Room value)
  { label: 'Adams, Sahara — SPED',                    value: '278'      },
  { label: 'Adriano, Ben — SPED',                     value: '217'      },
  { label: 'Ames, Michell — ELL',                     value: '273'      },
  { label: 'Arnold, Patti — Dean of Students',        value: '121'      },
  { label: 'Ashby, Briana — Comm. Arts',              value: '320'      },
  { label: 'Baker, Samantha — Comm. Arts',            value: '321'      },
  { label: 'Baldwin, Dustin — Government',            value: '314'      },
  { label: 'Beck, Kitty — Comm. Arts',                value: '250'      },
  { label: 'Bennett, Cristy — Homebound',             value: '121'      },
  { label: 'Blansit, Brenda — PE',                    value: 'Gym/184'  },
  { label: 'Blansit, Danelle — Athletics/Activities', value: '273'      },
  { label: 'Boyce, Andrew — PE',                      value: 'Gym/184'  },
  { label: 'Bradford, Michael — Band',                value: 'Band Rm'  },
  { label: 'Brantner, Amber — Business',              value: '215'      },
  { label: 'Brumley, Lance — Science',                value: '263'      },
  { label: 'Burford, Barrett — Comm. Arts',           value: '257'      },
  { label: 'Burger, Lisa — Math',                     value: '332'      },
  { label: 'Burns, Jordan — Business',                value: '214'      },
  { label: 'Burnside, Ryan — French',                 value: '176'      },
  { label: 'Cecenas, Jose — History/Govt.',           value: '305'      },
  { label: 'Chamberlain, Christine — Process Coord.', value: '252'      },
  { label: 'Clark, Brandon — Activities Director',    value: '276A'     },
  { label: 'Cobb, Lisa — Counselor Sec.',             value: '119'      },
  { label: 'Corya, Wendee — Math',                    value: '240'      },
  { label: 'Daniels, Lakyn — Drama',                  value: '199'      },
  { label: 'Davis, Sydney — Math',                    value: '309'      },
  { label: 'Dense, Ashley — Spanish',                 value: '170'      },
  { label: 'Donham, Katie — Science',                 value: '265'      },
  { label: 'Durham, Jessica — History',               value: '310'      },
  { label: 'Dye, Diane — Nurse',                      value: '124'      },
  { label: 'Edwards, Alexander — History',            value: '303'      },
  { label: 'Eggleston, Beth — Journalism',            value: '221'      },
  { label: 'Fergus, Kim — Spanish',                   value: '171'      },
  { label: 'Fields, Kelly — Indust. Tech.',           value: 'COC'      },
  { label: 'Finger, Craig — Band',                    value: 'A100'     },
  { label: 'Finke, Jennifer — District Social Worker',value: '224'      },
  { label: 'Finley, Ashley — Counselor CC/A+',        value: '139'      },
  { label: 'Fleetwood, Allison — Drama',              value: 'A133'     },
  { label: 'Foster, Jason — Science',                 value: '277'      },
  { label: 'Francis, Krista — SPED',                  value: '206'      },
  { label: 'Garrison, Sarah — Math',                  value: '325'      },
  { label: 'Gibson, Jennifer — Registrar',            value: '114'      },
  { label: 'Glenn, Cory — Drama',                     value: 'A140'     },
  { label: 'Gold, Jonathan — Weight Room',            value: '1001'     },
  { label: 'Goodyear, Kimberly — Comm. Arts',         value: '249'      },
  { label: 'Gunther, Teri — Science',                 value: '318'      },
  { label: 'Gutierrez, Daniel — Music',               value: 'A125'     },
  { label: 'Hamilton, Lindsey — SPED',                value: '208'      },
  { label: 'Hancock, Chloe — Math/Science',           value: '237'      },
  { label: 'Hardy, Aubrey — SPED',                    value: '189'      },
  { label: 'Harris, Angie — Comm. Arts',              value: '223'      },
  { label: 'Hartsell, Diana — Counselor Virtual',     value: '138'      },
  { label: 'Hartsell, Jason — School Police Chief',   value: '127'      },
  { label: 'Heckman, Kristine — Math',                value: '233'      },
  { label: 'Hefley, Angela — Science',                value: '269'      },
  { label: 'Herring, Alisha — SPED',                  value: '213'      },
  { label: 'Hill, Bill — Help Desk',                  value: '136'      },
  { label: 'Hodapp, Robert — JROTC',                  value: '181'      },
  { label: 'Horton, Megan — Math',                    value: '238'      },
  { label: 'Howard, Kallie — Process Coordinator',    value: '252'      },
  { label: 'Howard, Michaela — Comm. Arts',           value: '255'      },
  { label: 'Hower, Regina — District Social Worker',  value: '244'      },
  { label: 'Hughes, Logan — Opport. Plus',            value: '282'      },
  { label: 'Humes, Alician — SPED',                   value: '188'      },
  { label: 'Hunt, Randi — Counselor 9th',             value: '115'      },
  { label: 'Hurlbert, Brier — Print Shop',            value: '220'      },
  { label: 'Johns, Melissa — SPED',                   value: '326'      },
  { label: 'Jones, Tiffany — Curr. Specialist',       value: '103'      },
  { label: 'Jordan, Theodor — Science',               value: '268'      },
  { label: 'Kauffman, Tiffany — Indust. Tech.',       value: 'COC'      },
  { label: 'Kelly, David — Principal',                value: "Principal's Office" },
  { label: 'Killen, Tyler — Business',                value: '216'      },
  { label: 'Lambton, Ben — SPED',                     value: '222'      },
  { label: 'Langston, Traci — CC/A+ Sec.',            value: '139'      },
  { label: 'Lansdown, Melinda — Nurse',               value: '124'      },
  { label: 'Lawless, Shane — Comm. Arts',             value: '256'      },
  { label: 'Lazaro, Holly — Office Manager',          value: '102'      },
  { label: 'Lechner, Rachel — Comm. Arts',            value: '258'      },
  { label: 'Link, Niki — Attendance Sec.',            value: '103'      },
  { label: 'Livengood, Erin — Comm. Arts',            value: '260'      },
  { label: 'Lotz, Melissa — Math',                    value: '330'      },
  { label: 'Lutz, Janet — ASL Para',                  value: '323'      },
  { label: 'Mancini, Nicole — Finance Sec.',          value: '103'      },
  { label: 'Mann, Elliott — Art',                     value: '236'      },
  { label: 'Marsiglio, Annaliese — Math',             value: '242'      },
  { label: 'Martin, Dustin — Opport. Plus',           value: '212'      },
  { label: 'Martin, Hannah — Science',                value: '266'      },
  { label: 'Mason, Robin — SPED',                     value: '211'      },
  { label: 'McCoy, Jeremy — Asst. Activities Director', value: '276B'  },
  { label: 'McElhinney, Curtis — Math',               value: '241'      },
  { label: 'McGowan, Rachel — SPED',                  value: '126'      },
  { label: 'McMillin, Matthew — Asst. Principal 9th', value: '107'      },
  { label: 'Miller, Scott — History',                 value: '314A'     },
  { label: 'Mitchell, David — Art',                   value: '228'      },
  { label: 'Montana, Taylor — Comm. Arts',            value: '246'      },
  { label: 'Motto, Tania — Math',                     value: '328'      },
  { label: 'Myler, Jenney — Counselor 12th',          value: '117'      },
  { label: 'Nelson, Holly — Math',                    value: '239'      },
  { label: 'Nelson, Zac — Science',                   value: '262'      },
  { label: 'Newberry, Ashley — FACS',                 value: '218'      },
  { label: "O'Bryant, Erika — Band",                  value: 'Band Rm'  },
  { label: 'Palmer, Evan — Government',               value: '304'      },
  { label: 'Patterson, Kim — Band',                   value: 'A128'     },
  { label: 'Perry, Ana — Spanish',                    value: '172'      },
  { label: 'Perry, John — Weight Room',               value: 'Weight Room - 1001' },
  { label: 'Posegate, Josh — Government',             value: '311B'     },
  { label: 'Pycior, Stephanie — FACS',                value: '227'      },
  { label: 'Rapp, Whitney — Science',                 value: '317'      },
  { label: 'Reichert, Jonah — History',               value: '308'      },
  { label: 'Richardson, Rob — Health',                value: '191'      },
  { label: 'Roller, Alayna — Asst. Principal 10th',   value: '104'      },
  { label: 'Sartin, Kim — SPED',                      value: '209'      },
  { label: 'Shepherd, Christina — Science',           value: '281'      },
  { label: 'Smith, Kari — Kitchen Manager',           value: 'Kitchen'  },
  { label: 'Spayde, Kirby — Band',                    value: 'Band Rm'  },
  { label: 'Spence, Jonathon — Comm. Arts',           value: '248'      },
  { label: 'Staats, Julie — Librarian',               value: 'Library'  },
  { label: 'Stammers, Jennifer — Music',              value: 'A124'     },
  { label: 'Stoll, Amanda — Comm. Arts',              value: '319'      },
  { label: 'Stormazd, Carrie — Counselor 10th',       value: '112'      },
  { label: 'Stubblefield, Tammy — Music',             value: 'A125'     },
  { label: 'Sustaita, Nohemi — Spanish',              value: '173'      },
  { label: 'Sweet, Veronica — ASL',                   value: '323'      },
  { label: 'Sweitzer, Matt — Tech. Support Spec.',    value: '245'      },
  { label: 'Talbert, Jennifer — PE/Health',           value: 'Gym/194'  },
  { label: 'Teed, Chris — History',                   value: '307'      },
  { label: 'Thompson, Brooke — Science',              value: '275'      },
  { label: 'Uber, Dana — Counselor 11th',             value: '116'      },
  { label: 'Villanueva, George — History',            value: '280'      },
  { label: 'Villanueva, Melissa — Curr. Specialist',  value: '302'      },
  { label: 'Vincent, Emma — Science',                 value: '272'      },
  { label: 'Vincent, Tina — Library Aide',            value: 'Library'  },
  { label: 'Walker, Matt — History',                  value: '313'      },
  { label: 'Walton, Amanda — Math',                   value: '235'      },
  { label: 'Widel, Ryan — Art',                       value: '234'      },
  { label: 'Wilbur, Steven — SPO',                    value: '127'      },
  { label: 'Williamson, Jay — Speech/Debate',         value: '169'      },
  { label: 'Willis, Jody — Science',                  value: '315'      },
  { label: 'Wood, Marcy — FACS',                      value: '226'      },
  { label: 'Wright, Jaime L. — SPED',                 value: '225'      },
  { label: 'Wright, R. — Assoc. Principal 12th',      value: '105'      },
  { label: 'Yeager, Elizabeth — History',             value: '306'      },
  { label: 'Zimmerman, Annie — PE',                   value: 'Gym/196'  },
  // NHS Locations
  { label: 'Admin Conference Room',                   value: '111'      },
  { label: 'AETOS Box Office',                        value: 'AETOS'    },
  { label: 'Birdhouse',                               value: 'Library'  },
  { label: 'Burrell Office',                          value: '231'      },
  { label: 'Computer Lab B — Library',                value: '137'      },
  { label: 'Cox Clinic',                              value: '123'      },
  { label: 'Help Desk',                               value: '136'      },
  { label: 'Homebound',                               value: '121'      },
  { label: 'ISS — In School Suspension',              value: '168'      },
  { label: 'Kitchen',                                 value: 'Kitchen'  },
  { label: 'Lecture Hall A & B',                      value: '329/331'  },
  { label: 'Library',                                 value: 'Library'  },
  { label: 'Nurse',                                   value: '124'      },
  { label: 'Piano Lab / Choir Room',                  value: 'A128'     },
  { label: 'Print Shop',                              value: '220'      },
  { label: 'Room 210',                                value: '210'      },
  { label: 'School Police Office',                    value: '127'      },
  { label: 'Technology Rep',                          value: '243'      },
  { label: 'Writing Center',                          value: '259'      },
  { label: '1st Floor Work Room',                     value: '125'      },
  { label: '2nd Floor Work Room',                     value: '229'      },
  { label: '3rd Floor Work Room',                     value: '312'      },
];

const MATHEWS_LOCATIONS = [
  // Teachers (Last, First — Grade/Role : Room value)
  { label: 'Agans, Kayla — 1st Grade',               value: '199'          },
  { label: 'Anderson, Jennifer — Kindergarten',       value: '202'          },
  { label: 'Bax, Elizabeth — Reading',                value: '212'          },
  { label: 'Bergin, Rachel — 1st Grade',              value: '205'          },
  { label: 'Bowen, Devon — 4th Grade',                value: '300'          },
  { label: 'Bracker, Ashley — 3rd Grade',             value: '303'          },
  { label: 'Brammer, Robyn — Kindergarten',           value: '196'          },
  { label: 'Brock, Shayne — Counselor',               value: 'Office'       },
  { label: 'Brower, Sarah — Instructional Coach',     value: 'Office'       },
  { label: 'Carter, Litishia — Process Coord.',       value: 'Office'       },
  { label: 'Carter, McKensie — 4th Grade',            value: '306'          },
  { label: 'Eason, Elizabeth — Reading',              value: '322'          },
  { label: 'Edwards, Rebecca — Reading',              value: '212'          },
  { label: 'Gerkin, Erika — 4th Grade',               value: '304'          },
  { label: 'Gilley, Aspen — Building Sub',            value: 'Office'       },
  { label: 'Gray, Alicia — ELL',                      value: 'ELL Room'     },
  { label: 'Hartzler, Lauren — Resource',             value: '210'          },
  { label: 'Herrold, Lakynn — 1st Grade',             value: '197'          },
  { label: 'Hurn, Janelle — Music',                   value: 'Music Room'   },
  { label: 'Johnson, Carol — Resource',               value: '215'          },
  { label: 'Keller, Leandra — Office Mgr.',           value: 'Office'       },
  { label: 'Lea, Paitlyn — 3rd Grade',                value: '308'          },
  { label: 'Lindsey, Emalie — Library',               value: 'Library'      },
  { label: 'Mancusi, Sarah — 3rd Grade',              value: '309'          },
  { label: 'Mancusi, Vinny — Technician',             value: 'Office'       },
  { label: 'Mathie, Teal — SLP',                      value: '201'          },
  { label: 'McCollum, Peyton — Kindergarten',         value: '198'          },
  { label: 'McLain, Kelli — PT',                      value: '203'          },
  { label: 'Miesner, Sarah — Asst. Principal',        value: 'Office'       },
  { label: 'Nickerson, Zach — 3rd Grade',             value: '305'          },
  { label: 'Noskowiak, Aimee — 2nd Grade',            value: '310'          },
  { label: 'Piwko, Tami — Nurse',                     value: "Nurse's Office" },
  { label: 'Poivre, Brooke — PE',                     value: 'Gym'          },
  { label: 'Quackenbush, Becky — Principal',          value: 'Office'       },
  { label: 'Ramsey, Brittany — OT',                   value: '203'          },
  { label: 'Richardson, Gwyneth — Library Aide',      value: 'Library'      },
  { label: 'Richardson, Megan — SLP',                 value: '201'          },
  { label: 'Roach, Rachel — 2nd Grade',               value: '316'          },
  { label: 'Sackman, Melissa — 1st Grade',            value: '207'          },
  { label: 'Schatzer, Chelsea — HN',                  value: '206'          },
  { label: 'Shelton, Nicole — 2nd Grade',             value: '314'          },
  { label: 'Shiver, Delbert — 4th Grade',             value: '302'          },
  { label: 'Smith, Stephanie — 4th Grade',            value: '301'          },
  { label: 'Stech, Lynsey — Resource',                value: '319'          },
  { label: 'Stricklin, Kelli — Art',                  value: 'Art Room'     },
  { label: 'Swearengin, Ashley — Kindergarten',       value: '204'          },
  { label: 'Tapken, Judy — Media',                    value: 'Media Center' },
  { label: 'Tyler, Jasmine — Kindergarten',           value: '200'          },
  { label: 'Weaver, Jennifer — 2nd Grade',            value: '315'          },
  { label: 'Wehling, Laurin — 3rd Grade',             value: '307'          },
  // Mathews Locations
  { label: 'Art Room',                                value: 'Art Room'     },
  { label: 'Gym',                                     value: 'Gym'          },
  { label: 'Kitchen',                                 value: 'Kitchen'      },
  { label: 'Library / Media Center',                  value: 'Library'      },
  { label: 'Music Room',                              value: 'Music Room'   },
  { label: "Nurse's Office",                          value: "Nurse's Office" },
  { label: 'Office',                                  value: 'Office'       },
];

function initLocationAutocomplete(inputId, getLocations) {
  const input    = document.getElementById(inputId);
  const dropdown = document.getElementById('ac-' + inputId);
  if (!input || !dropdown) return;
  let activeIdx = -1;

  function getMatches(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const tokens = q.split(/\s+/);
    const locations = getLocations ? getLocations() : NHS_LOCATIONS;
    return locations
      .map(entry => {
        const haystack = (entry.label + ' ' + entry.value).toLowerCase();
        if (!tokens.every(t => haystack.includes(t))) return null;
        const score = tokens.reduce((s, t) => {
          const i = haystack.indexOf(t);
          return s + (i === 0 || haystack[i - 1] === ' ' ? 2 : 1);
        }, 0);
        return { entry, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(x => x.entry);
  }

  const acId = 'ac-opt-' + inputId;

  function renderDropdown(matches) {
    if (!matches.length) {
      dropdown.classList.remove('open');
      dropdown.innerHTML = '';
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      return;
    }
    dropdown.innerHTML = matches.map((m, i) =>
      `<div class="autocomplete-item" role="option" aria-selected="false" id="${acId}-${i}" data-value="${m.value.replace(/"/g,'&quot;')}" data-idx="${i}">
        <span class="autocomplete-item-name">${m.label}</span>
        <span class="autocomplete-item-room">${m.value}</span>
      </div>`
    ).join('');
    activeIdx = -1;
    dropdown.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
    input.removeAttribute('aria-activedescendant');
    dropdown.querySelectorAll('.autocomplete-item').forEach(el => {
      el.addEventListener('mousedown', function(e) { e.preventDefault(); selectValue(this.dataset.value); });
    });
  }

  function selectValue(val) {
    input.value = val;
    dropdown.classList.remove('open');
    dropdown.innerHTML = '';
    activeIdx = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function setActiveItem(idx) {
    const items = dropdown.querySelectorAll('.autocomplete-item');
    items.forEach((el, i) => {
      el.classList.toggle('kbd-active', i === idx);
      el.setAttribute('aria-selected', i === idx ? 'true' : 'false');
    });
    activeIdx = idx;
    if (idx >= 0) {
      input.setAttribute('aria-activedescendant', `${acId}-${idx}`);
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  input.addEventListener('input',  () => renderDropdown(getMatches(input.value)));
  input.addEventListener('focus',  () => { if (input.value) renderDropdown(getMatches(input.value)); });
  input.addEventListener('blur',   () => setTimeout(() => {
    dropdown.classList.remove('open');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }, 150));
  input.addEventListener('keydown', e => {
    const items = dropdown.querySelectorAll('.autocomplete-item');
    if (!items.length) return;
    if (e.key === 'ArrowDown')  { e.preventDefault(); setActiveItem(Math.min(activeIdx + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveItem(Math.max(activeIdx - 1, 0)); }
    else if (e.key === 'Enter' && activeIdx >= 0) { e.preventDefault(); selectValue(items[activeIdx].dataset.value); }
    else if (e.key === 'Escape') { dropdown.classList.remove('open'); input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
  });
}
