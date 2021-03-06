/**
 * Profiles are switchable profiles
 */
import {
  getDefaultProfileID,
  getDefaultProfile,
  Profile,
  genProfilesStorage,
  ProfileIDList,
  ProfileID,
} from '@/app-config/profiles'
import { mergeProfile } from '@/app-config/merge-profile'
import { storage } from './browser-api'
import { TranslationFunction } from 'i18next'

import { Observable } from 'rxjs/Observable'
import { from } from 'rxjs/observable/from'
import { concat } from 'rxjs/observable/concat'
import { map } from 'rxjs/operators/map'
import { fromEventPattern } from 'rxjs/observable/fromEventPattern'

export interface StorageChanged<T> {
  newValue: T,
  oldValue?: T,
}

export interface ProfileChanged {
  newProfile: Profile,
  oldProfile?: Profile,
}

export function getProfileName (name: string, t: TranslationFunction): string {
  // default names
  const match = /^%%_(\S+)_%%$/.exec(name)
  if (match) {
    return t(`profile:${match[1]}`) || name
  }
  return name
}

export async function initProfiles (): Promise<Profile> {
  let profiles: Profile[] = []
  let profileIDList: ProfileIDList = []
  let activeProfileID = ''

  let response = await storage.sync.get<{
    profileIDList: ProfileIDList
    activeProfileID: string
  }>(['profileIDList', 'activeProfileID'])

  if (response.profileIDList) {
    profileIDList = response.profileIDList.filter(Boolean)
  }

  if (response.activeProfileID) {
    activeProfileID = response.activeProfileID
  }

  if (profileIDList.length > 0) {
    // quota bytes limit
    for (const { id } of profileIDList) {
      const profile = (await storage.sync.get(id))[id]
      profiles.push(profile ? mergeProfile(profile) : getDefaultProfile(id))
    }
  }

  // legacy
  if (profileIDList.length <= 0) {
    const {
      configProfileIDs,
      activeConfigID,
    } = await storage.sync.get<{
      configProfileIDs: string[],
      activeConfigID: string,
    }>(['configProfileIDs', 'activeConfigID'])

    if (configProfileIDs && configProfileIDs.length > 0) {
      // quota bytes limit
      for (const id of configProfileIDs) {
        const config = (await storage.sync.get(id))[id]
        const profile = config ? mergeProfile(config) : getDefaultProfile(id)
        const profileID = config && config.name
          ? {
            id: id,
            name: config.name
          }
          : getDefaultProfileID(id)
        // the first item is active
        profileIDList.push(profileID)
        profiles.push(profile)
        if (id === activeConfigID) {
          activeProfileID = id
        }
      }
    }
  }

  if (profileIDList.length <= 0) {
    ({ profileIDList, profiles } = genProfilesStorage())
  }

  if (!activeProfileID) {
    activeProfileID = profileIDList[0].id
  }

  let activeProfile = profiles.find(({ id }) => id === activeProfileID)
  if (!activeProfile) {
    activeProfile = profiles[0]
    activeProfileID = activeProfile.id
  }

  await storage.sync.set({ profileIDList, activeProfileID })

  // quota bytes per item limit
  for (const profile of profiles) {
    await storage.sync.set({ [profile.id]: profile })
  }

  return activeProfile
}

export async function resetAllProfiles () {
  const { profileIDList } = await storage.sync.get<{
    profileIDList: ProfileIDList
  }>('profileIDList')

  if (profileIDList) {
    await storage.sync.remove([
      ...profileIDList.map(({ id }) => id),
      'profileIDList',
      'activeProfileID',
    ])
  }
  return initProfiles()
}

export async function getProfile (id: string): Promise<Profile | undefined> {
  return (await storage.sync.get(id))[id]
}

/**
 * Update profile
 */
export async function updateProfile (profile: Profile): Promise<void> {
  if (process.env.DEV_BUILD) {
    const profileIDList = await getProfileIDList()
    if (!profileIDList.find(item => item.id === profile.id)) {
      console.error(`Update Profile: profile ${profile.id} does not exist`)
    }
  }
  return storage.sync.set({ [profile.id]: profile })
}

export async function addProfile (profileID: ProfileID): Promise<void> {
  const id = profileID.id
  const profileIDList = await getProfileIDList()
  if (process.env.DEV_BUILD) {
    if (profileIDList.find(item => item.id === id) ||
      (await storage.sync.get(id))[id]
    ) {
      console.warn(`Add profile: profile ${id} exists`)
    }
  }

  return storage.sync.set({
    profileIDList: [...profileIDList, profileID],
    [id]: getDefaultProfile(id),
  })
}

export async function removeProfile (id: string): Promise<void> {
  const activeProfileID = await getActiveProfileID()
  let profileIDList = await getProfileIDList()
  if (process.env.DEV_BUILD) {
    if (!profileIDList.find(item => item.id === id) ||
       !(await storage.sync.get(id))[id]
    ) {
      console.warn(`Remove profile: profile ${id} does not exists`)
    }
  }
  profileIDList = profileIDList.filter(item => item.id !== id)
  if (activeProfileID === id) {
    await updateActiveProfileID(profileIDList[0].id)
  }
  await updateProfileIDList(profileIDList)
  return storage.sync.remove(id)
}

/**
 * Get the profile under the current mode
 */
export async function getActiveProfile (): Promise<Profile> {
  const activeProfileID = await getActiveProfileID()
  if (activeProfileID) {
    const profile = await getProfile(activeProfileID)
    if (profile) {
      return profile
    }
  }
  return getDefaultProfile()
}

export async function getActiveProfileID (): Promise<string> {
  return (await storage.sync.get('activeProfileID')).activeProfileID || ''
}

export function updateActiveProfileID (id: string): Promise<void> {
  return storage.sync.set({ activeProfileID: id })
}

/**
 * This is mainly for ordering
 */
export async function getProfileIDList (): Promise<ProfileIDList> {
  return (await storage.sync.get('profileIDList')).profileIDList || []
}

/**
 * This is mainly for ordering
 */
export function updateProfileIDList (list: ProfileIDList): Promise<void> {
  return storage.sync.set({ profileIDList: list })
}

export function addActiveProfileIDListener (
  cb: (changes: StorageChanged<string>) => any
) {
  storage.sync.addListener('activeProfileID', ({ activeProfileID }) => {
    if (activeProfileID && activeProfileID.newValue) {
      cb(activeProfileID as StorageChanged<string>)
    }
  })
}

export function addProfileIDListListener (
  cb: (changes: StorageChanged<ProfileIDList>) => any
) {
  storage.sync.addListener('profileIDList', ({ profileIDList }) => {
    if (profileIDList && profileIDList.newValue) {
      cb(profileIDList as StorageChanged<ProfileIDList>)
    }
  })
}

/**
 * Listen storage changes of the current profile
 */
export async function addActiveProfileListener (
  cb: (changes: ProfileChanged) => any
) {
  let activeID: string | undefined = await getActiveProfileID()

  storage.sync.addListener(changes => {
    if (changes.activeProfileID) {
      const {
        newValue: newID,
        oldValue: oldID,
      } = (changes as { activeProfileID: StorageChanged<string> }).activeProfileID
      if (newID) {
        activeID = newID
        if (oldID) {
          storage.sync.get([oldID, newID]).then(obj => {
            if (obj[newID]) {
              cb({ newProfile: obj[newID], oldProfile: obj[oldID] })
              return
            }
          })
        } else {
          storage.sync.get(newID).then(response => {
            const newProfile = response[newID]
            if (newProfile) {
              cb({ newProfile })
              return
            }
          })
        }
      }
    }

    if (activeID && changes[activeID]) {
      const { newValue, oldValue } = changes[activeID]
      if (newValue) {
        cb({ newProfile: newValue, oldProfile: oldValue })
        return
      }
    }
  })
}

/**
 * Get active profile and create a stream listening to profile changing
 */
export function createProfileIDListStream (): Observable<ProfileIDList> {
  return concat(
    from(getProfileIDList()),
    fromEventPattern<[StorageChanged<ProfileIDList>] | StorageChanged<ProfileIDList>>(
      addProfileIDListListener as any
    ).pipe(
      map(args => (Array.isArray(args) ? args[0] : args).newValue),
    ),
  )
}

/**
 * Get active profile and create a stream listening to profile changing
 */
export function createActiveProfileStream (): Observable<Profile> {
  return concat(
    from(getActiveProfile()),
    fromEventPattern<[ProfileChanged] | ProfileChanged>(addActiveProfileListener as any).pipe(
      map(args => (Array.isArray(args) ? args[0] : args).newProfile),
    ),
  )
}
